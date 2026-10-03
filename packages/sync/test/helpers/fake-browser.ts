/**
 * A fake Playwright layer.
 *
 * Unit tests must never connect to a real browser (the engine cannot even be spawned inside this
 * machine's sandbox), so every test drives these objects instead: they record exactly which
 * Playwright calls the synchroniser made, and let a test pretend a window is slow, has no page,
 * or disconnects.
 */

import type { CoreLogger } from '@vfox/core'
import type {
  BindingSourceLike,
  BrowserConnector,
  BrowserLike,
  ContextLike,
  Disposable,
  KeyboardLike,
  MouseLike,
  PageLike,
  ViewportSize,
} from '../../src/browser.js'

export interface ReplayCall {
  method: 'move' | 'down' | 'up' | 'click' | 'wheel' | 'key-down' | 'key-up'
  args: unknown[]
}

export class FakePage implements PageLike {
  readonly calls: ReplayCall[] = []
  readonly evaluated: string[] = []
  readonly mouse: MouseLike
  readonly keyboard: KeyboardLike

  /** While set, every replay call waits on it — a slow slave. */
  gate: Promise<void> | null = null
  /** Makes the next `evaluate()` reject, like a page that is navigating away. */
  failEvaluate: string | null = null

  #fixedViewport: ViewportSize | null = null
  #measured: ViewportSize = { width: 1280, height: 800 }
  #closed = false
  readonly #closeListeners = new Set<() => void>()

  constructor(options: { fixedViewport?: ViewportSize; measured?: ViewportSize } = {}) {
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

  setMeasuredViewport(size: ViewportSize): void {
    this.#measured = size
  }

  viewportSize(): ViewportSize | null {
    return this.#fixedViewport
  }

  async evaluate<T>(expression: string): Promise<T> {
    this.evaluated.push(expression)
    if (this.failEvaluate) {
      const failure = this.failEvaluate
      this.failEvaluate = null
      throw new Error(failure)
    }
    if (expression.includes('innerWidth')) {
      return { width: this.#measured.width, height: this.#measured.height } as T
    }
    return undefined as T
  }

  isClosed(): boolean {
    return this.#closed
  }

  on(_event: 'close', listener: () => void): this {
    this.#closeListeners.add(listener)
    return this
  }

  off(_event: 'close', listener: () => void): this {
    this.#closeListeners.delete(listener)
    return this
  }

  /** Test helper: the user closed this window. */
  closeWindow(): void {
    this.#closed = true
    for (const listener of [...this.#closeListeners]) {
      listener()
    }
  }

  async #waitForGate(): Promise<void> {
    if (this.gate) {
      await this.gate
    }
  }
}

export class FakeContext implements ContextLike {
  readonly pageList: FakePage[] = []
  readonly initScripts: string[] = []
  binding: {
    name: string
    callback: (source: BindingSourceLike, payload: unknown) => unknown
  } | null = null
  bindingDisposed = false

  readonly #pageListeners = new Set<(page: FakePage) => void>()

  pages(): FakePage[] {
    return [...this.pageList]
  }

  get pageListenerCount(): number {
    return this.#pageListeners.size
  }

  async exposeBinding(
    name: string,
    callback: (source: BindingSourceLike, payload: unknown) => unknown,
  ): Promise<Disposable> {
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

  async addInitScript(script: string): Promise<Disposable> {
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

  on(_event: 'page', listener: (page: FakePage) => void): this {
    this.#pageListeners.add(listener)
    return this
  }

  off(_event: 'page', listener: (page: FakePage) => void): this {
    this.#pageListeners.delete(listener)
    return this
  }

  /** Test helper: a window (or tab) appears in this context. */
  openPage(page: FakePage = new FakePage()): FakePage {
    this.pageList.push(page)
    for (const listener of [...this.#pageListeners]) {
      listener(page)
    }
    return page
  }

  /** Test helper: the master page reports one input event through the binding. */
  report(payload: unknown): unknown {
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

export class FakeBrowser implements BrowserLike {
  readonly contexts_: FakeContext[] = []
  /** `close()` on a connected browser closes the connection, never the user's window. */
  connectionClosed = false

  readonly #disconnected = new Set<() => void>()

  contexts(): FakeContext[] {
    return [...this.contexts_]
  }

  get disconnectListenerCount(): number {
    return this.#disconnected.size
  }

  async close(): Promise<void> {
    this.connectionClosed = true
  }

  on(_event: 'disconnected', listener: () => void): this {
    this.#disconnected.add(listener)
    return this
  }

  off(_event: 'disconnected', listener: () => void): this {
    this.#disconnected.delete(listener)
    return this
  }

  /** Test helper: the browser process went away (window closed, crash, engine stop). */
  disconnect(): void {
    for (const listener of [...this.#disconnected]) {
      listener()
    }
  }
}

export interface FakeProfile {
  id: string
  name: string
  browser: FakeBrowser
  context: FakeContext
  page: FakePage
  target: { wsEndpoint: string | null; pid: number | null; name: string }
}

/** A set of fake profiles plus the connector the session attaches through. */
export class FakeWorld {
  readonly connectCalls: string[] = []
  readonly profiles = new Map<string, FakeProfile>()
  readonly #dead = new Set<string>()

  readonly connect: BrowserConnector = async wsEndpoint => {
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
  kill(wsEndpoint: string): () => void {
    this.#dead.add(wsEndpoint)
    return () => {
      this.#dead.delete(wsEndpoint)
    }
  }

  readonly resolve = (profileId: string): FakeProfile['target'] | undefined =>
    this.profiles.get(profileId)?.target

  add(
    id: string,
    options: { pid?: number; page?: FakePage; withPage?: boolean; name?: string } = {},
  ): FakeProfile {
    const context = new FakeContext()
    const page = options.page ?? new FakePage()
    if (options.withPage !== false) {
      context.pageList.push(page)
    }
    const browser = new FakeBrowser()
    browser.contexts_.push(context)
    const profile: FakeProfile = {
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
export function mousePayload(
  kind: 'mousedown' | 'mouseup' | 'click' | 'mousemove' | 'wheel',
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, x, y, button: 0, vw: 1280, vh: 800, ...extra }
}

export function keyPayload(
  kind: 'keydown' | 'keyup',
  key: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, key, vw: 1280, vh: 800, ...extra }
}

/** Resolves when `check()` is true, or throws after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the expected state')
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** A `CoreLogger` that keeps what it was told, so tests can assert on warnings. */
export interface TestLogger {
  logger: CoreLogger
  warnings: string[]
  debug: string[]
}

export function testLogger(): TestLogger {
  const warnings: string[] = []
  const debug: string[] = []
  return {
    warnings,
    debug,
    logger: {
      debug: (message: string) => {
        debug.push(message)
      },
      info() {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error() {},
    },
  }
}
