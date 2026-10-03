/**
 * The master side of a sync session: attach to the master profile's running browser, install the
 * input listener, and report every real input event to the session.
 *
 * The connection is a *second* client on a browser the engine already runs in
 * `launchServerShared` mode, so disconnecting must never close the user's window — `detach()`
 * closes the connection and nothing else. `scripts/smoke-sync.mjs` asserts that in CI.
 */

import type { CoreLogger } from '@vfox/core'
import type { BrowserConnector, BrowserLike, ContextLike, Disposable, PageLike } from './browser.js'
import { SyncError } from './errors.js'
import { SYNC_BINDING_NAME, SYNC_LISTENER_SOURCE, SYNC_TEARDOWN_SOURCE } from './mirror.js'

export interface MasterOptions {
  profileId: string
  /** Human name from the caller's resolver, used in messages only. */
  label: string
  wsEndpoint: string
  connect: BrowserConnector
  logger: CoreLogger
  onEvent: (payload: unknown) => void
  onGone: () => void
}

export class MasterLink {
  readonly profileId: string

  readonly #browser: BrowserLike
  readonly #context: ContextLike
  readonly #logger: CoreLogger
  readonly #binding: Disposable
  readonly #initScript: Disposable
  readonly #onPage: (page: PageLike) => void
  readonly #onDisconnected: () => void
  #detached = false

  private constructor(
    options: MasterOptions,
    browser: BrowserLike,
    context: ContextLike,
    binding: Disposable,
    initScript: Disposable,
  ) {
    this.profileId = options.profileId
    this.#browser = browser
    this.#context = context
    this.#logger = options.logger
    this.#binding = binding
    this.#initScript = initScript
    this.#onPage = page => {
      void this.#install(page)
    }
    this.#onDisconnected = () => {
      if (!this.#detached) {
        options.onGone()
      }
    }
  }

  static async attach(options: MasterOptions): Promise<MasterLink> {
    const browser = await connectOrThrow(options)
    const context = browser.contexts()[0]
    if (!context) {
      throw new SyncError(
        `profile "${options.label}" exposed no browser context to attach to`,
        'attach_failed',
      )
    }

    // `exposeBinding` installs the function into every frame of every page that already exists,
    // and the init script repeats it for documents created later.
    const binding = await context.exposeBinding(SYNC_BINDING_NAME, (_source, payload) => {
      options.onEvent(payload)
    })
    const initScript = await context.addInitScript(SYNC_LISTENER_SOURCE)

    const link = new MasterLink(options, browser, context, binding, initScript)
    context.on('page', link.#onPage)
    browser.on('disconnected', link.#onDisconnected)
    for (const page of context.pages()) {
      await link.#install(page)
    }
    return link
  }

  /** Stop reporting and detach the connection. The browser and its window keep running. */
  async detach(): Promise<void> {
    if (this.#detached) {
      return
    }
    this.#detached = true
    this.#context.off('page', this.#onPage)
    this.#browser.off('disconnected', this.#onDisconnected)

    for (const page of this.#pages()) {
      try {
        await page.evaluate(SYNC_TEARDOWN_SOURCE)
      } catch (error) {
        // The page may be gone already; the binding disposal below still removes the transport.
        this.#logger.debug(`sync: master teardown skipped a page: ${message(error)}`)
      }
    }
    await dispose(this.#binding, this.#logger)
    await dispose(this.#initScript, this.#logger)
    try {
      await this.#browser.close()
    } catch (error) {
      this.#logger.warn(`sync: master connection close failed: ${message(error)}`)
    }
  }

  async #install(page: PageLike): Promise<void> {
    try {
      await page.evaluate(SYNC_LISTENER_SOURCE)
    } catch (error) {
      this.#logger.warn(`sync: could not instrument a master page: ${message(error)}`)
    }
  }

  #pages(): PageLike[] {
    try {
      return this.#context.pages()
    } catch {
      return []
    }
  }
}

async function connectOrThrow(options: MasterOptions): Promise<BrowserLike> {
  try {
    return await options.connect(options.wsEndpoint)
  } catch (error) {
    throw new SyncError(
      `could not attach to profile "${options.label}": ${message(error)}`,
      'attach_failed',
    )
  }
}

async function dispose(disposable: Disposable, logger: CoreLogger): Promise<void> {
  try {
    await disposable.dispose()
  } catch (error) {
    logger.warn(`sync: releasing a master binding failed: ${message(error)}`)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
