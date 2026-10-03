/**
 * A fake Playwright layer.
 *
 * Unit tests must never connect to a real browser (the engine cannot even be spawned inside this
 * machine's sandbox), so every test drives these objects instead: they record exactly which
 * Playwright calls the synchroniser made, and let a test pretend a window is slow, has no page,
 * or disconnects.
 *
 * Plain `.mjs` on purpose: Vite transpiles TypeScript with esbuild, whose service process needs a
 * piped stdio slot this sandbox refuses, so a `.ts` test could never run locally. The tests import
 * the built `dist/` output, exactly like `packages/server` does.
 */

export class FakePage {
  calls = []
  evaluated = []
  mouse
  keyboard

  /** While set, every replay call waits on it — a slow slave. */
  gate = null
  /** Makes the next `evaluate()` reject, like a page that is navigating away. */
  failEvaluate = null

  #fixedViewport = null
  #measured = { width: 1280, height: 800 }
  #closed = false
  #closeListeners = new Set()

  constructor(options = {}) {
    if (options.fixedViewport) {
      this.#fixedViewport = options.fixedViewport
    }
    if (options.measured) {
      this.#measured = options.measured
    }
    this.mouse = {
      move: async (x, y) => {
        await this.#waitForGate()
        this.calls.push({ method: 'move', args: [x, y] })
      },
      down: async options2 => {
        await this.#waitForGate()
        this.calls.push({ method: 'down', args: [options2] })
      },
      up: async options2 => {
        await this.#waitForGate()
        this.calls.push({ method: 'up', args: [options2] })
      },
      click: async (x, y, options2) => {
        await this.#waitForGate()
        this.calls.push({ method: 'click', args: [x, y, options2] })
      },
      wheel: async (deltaX, deltaY) => {
        await this.#waitForGate()
        this.calls.push({ method: 'wheel', args: [deltaX, deltaY] })
      },
    }
    this.keyboard = {
      down: async key => {
        await this.#waitForGate()
        this.calls.push({ method: 'key-down', args: [key] })
      },
      up: async key => {
        await this.#waitForGate()
        this.calls.push({ method: 'key-up', args: [key] })
      },
    }
  }

  setMeasuredViewport(size) {
    this.#measured = size
  }

  viewportSize() {
    return this.#fixedViewport
  }

  async evaluate(expression) {
    this.evaluated.push(expression)
    if (this.failEvaluate) {
      const failure = this.failEvaluate
      this.failEvaluate = null
      throw new Error(failure)
    }
    if (expression.includes('innerWidth')) {
      return { width: this.#measured.width, height: this.#measured.height }
    }
    return undefined
  }

  isClosed() {
    return this.#closed
  }

  on(_event, listener) {
    this.#closeListeners.add(listener)
    return this
  }

  off(_event, listener) {
    this.#closeListeners.delete(listener)
    return this
  }

  /** Test helper: the user closed this window. */
  closeWindow() {
    this.#closed = true
    for (const listener of [...this.#closeListeners]) {
      listener()
    }
  }

  async #waitForGate() {
    if (this.gate) {
      await this.gate
    }
  }
}

export class FakeContext {
  pageList = []
  initScripts = []
  binding = null
  bindingDisposed = false

  #pageListeners = new Set()

  pages() {
    return [...this.pageList]
  }

  get pageListenerCount() {
    return this.#pageListeners.size
  }

  async exposeBinding(name, callback) {
    if (this.binding) {
      throw new Error(`Function "${name}" has been already registered`)
    }
    this.binding = { name, callback }
    return {
      dispose: async () => {
        this.bindingDisposed = true
        this.binding = null
      },
    }
  }

  async addInitScript(script) {
    this.initScripts.push(script)
    return {
      dispose: async () => {
        const index = this.initScripts.indexOf(script)
        if (index >= 0) {
          this.initScripts.splice(index, 1)
        }
      },
    }
  }

  on(_event, listener) {
    this.#pageListeners.add(listener)
    return this
  }

  off(_event, listener) {
    this.#pageListeners.delete(listener)
    return this
  }

  /** Test helper: a window (or tab) appears in this context. */
  openPage(page = new FakePage()) {
    this.pageList.push(page)
    for (const listener of [...this.#pageListeners]) {
      listener(page)
    }
    return page
  }

  /** Test helper: the master page reports one input event through the binding. */
  report(payload) {
    const binding = this.binding
    if (!binding) {
      throw new Error('this context has no sync binding installed')
    }
    const source = this.pageList[0]
    if (!source) {
      throw new Error('this context has no page to report from')
    }
    return binding.callback({ page: source }, payload)
  }
}

export class FakeBrowser {
  contexts_ = []
  /** `close()` on a connected browser closes the connection, never the user's window. */
  connectionClosed = false

  #disconnected = new Set()

  contexts() {
    return [...this.contexts_]
  }

  get disconnectListenerCount() {
    return this.#disconnected.size
  }

  async close() {
    this.connectionClosed = true
  }

  on(_event, listener) {
    this.#disconnected.add(listener)
    return this
  }

  off(_event, listener) {
    this.#disconnected.delete(listener)
    return this
  }

  /** Test helper: the browser process went away (window closed, crash, engine stop). */
  disconnect() {
    for (const listener of [...this.#disconnected]) {
      listener()
    }
  }
}

/** A set of fake profiles plus the connector the session attaches through. */
export class FakeWorld {
  connectCalls = []
  profiles = new Map()
  #dead = new Set()

  connect = async wsEndpoint => {
    this.connectCalls.push(wsEndpoint)
    if (this.#dead.has(wsEndpoint)) {
      throw new Error(`fake: nothing is listening on ${wsEndpoint}`)
    }
    for (const profile of this.profiles.values()) {
      if (profile.target.wsEndpoint === wsEndpoint) {
        return profile.browser
      }
    }
    throw new Error(`fake: nothing is listening on ${wsEndpoint}`)
  }

  /** Test helper: the profile still advertises this endpoint, but nothing answers on it. */
  kill(wsEndpoint) {
    this.#dead.add(wsEndpoint)
    return () => {
      this.#dead.delete(wsEndpoint)
    }
  }

  resolve = profileId => this.profiles.get(profileId)?.target

  add(id, options = {}) {
    const context = new FakeContext()
    const page = options.page ?? new FakePage()
    if (options.withPage !== false) {
      context.pageList.push(page)
    }
    const browser = new FakeBrowser()
    browser.contexts_.push(context)
    const profile = {
      id,
      name: options.name ?? id,
      browser,
      context,
      page,
      target: {
        wsEndpoint: `ws://127.0.0.1/${id}`,
        pid: options.pid ?? 1000 + this.profiles.size,
        name: options.name ?? id,
      },
    }
    this.profiles.set(id, profile)
    return profile
  }
}

/** A master input report, shaped exactly like the injected listener's payload. */
export function mousePayload(kind, x, y, extra = {}) {
  return { kind, x, y, button: 0, vw: 1280, vh: 800, ...extra }
}

export function keyPayload(kind, key, extra = {}) {
  return { kind, key, vw: 1280, vh: 800, ...extra }
}

/** Resolves when `check()` is true, or throws after `timeoutMs`. */
export async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the expected state')
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** A `CoreLogger` that keeps what it was told, so tests can assert on warnings. */
export function testLogger() {
  const warnings = []
  const debug = []
  return {
    warnings,
    debug,
    logger: {
      debug: message => {
        debug.push(message)
      },
      info() {},
      warn: message => {
        warnings.push(message)
      },
      error() {},
    },
  }
}
