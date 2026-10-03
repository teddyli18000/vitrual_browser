/**
 * One slave window: a queue, a replay loop and the back-pressure policy.
 *
 * Replaying input into another browser is I/O, and a slow slave must never slow the master down.
 * `enqueue()` is synchronous and never awaits; a single drain loop per slave replays in order.
 * When a slave cannot keep up, `mousemove` is dropped first — a lost intermediate mouse position
 * costs nothing because every click carries its own coordinates and is preceded by a `move` —
 * while clicks, keys and wheel events are only ever dropped when the queue hits its hard cap.
 */

import type { CoreLogger } from '@vfox/core'
import type { BrowserConnector, BrowserLike, ContextLike, PageLike } from './browser.js'
import { SyncError } from './errors.js'
import type { ViewportTracker } from './mapping.js'
import { createReplayState, type MirrorEvent, replayEvent } from './mirror.js'

export interface SlaveLimits {
  /** Pending `mousemove` events tolerated before new ones are dropped. */
  moves: number
  /** Hard cap on the whole pending queue. */
  queue: number
}

export interface SlaveDropped {
  moves: number
  noPage: number
  critical: number
}

export interface SlaveOptions {
  profileId: string
  /** Human name from the caller's resolver, used in messages only. */
  label: string
  wsEndpoint: string
  connect: BrowserConnector
  logger: CoreLogger
  viewports: ViewportTracker
  onGone: (profileId: string) => void
  limits?: Partial<SlaveLimits>
  /** How long an event waits for the slave to have a page at all. */
  pageWaitMs?: number
}

const DEFAULT_LIMITS: SlaveLimits = { moves: 8, queue: 256 }
const DEFAULT_PAGE_WAIT_MS = 3000

export class SlaveMirror {
  readonly profileId: string

  readonly #browser: BrowserLike
  readonly #context: ContextLike
  readonly #logger: CoreLogger
  readonly #viewports: ViewportTracker
  readonly #limits: SlaveLimits
  readonly #pageWaitMs: number
  readonly #onGone: (profileId: string) => void
  readonly #replay = createReplayState()
  readonly #dropped: SlaveDropped = { moves: 0, noPage: 0, critical: 0 }

  #page: PageLike | null = null
  #queue: MirrorEvent[] = []
  #draining: Promise<void> | null = null
  #waiters: ((page: PageLike | null) => void)[] = []
  #stopped = false
  #warnedFull = false

  readonly #onPage = (page: PageLike): void => {
    if (!this.#stopped) {
      this.#setPage(page)
    }
  }

  readonly #onPageClose = (): void => {
    this.#page = this.#pickPage()
  }

  readonly #onDisconnected = (): void => {
    if (!this.#stopped) {
      this.#onGone(this.profileId)
    }
  }

  private constructor(options: SlaveOptions, browser: BrowserLike, context: ContextLike) {
    this.profileId = options.profileId
    this.#browser = browser
    this.#context = context
    this.#logger = options.logger
    this.#viewports = options.viewports
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#pageWaitMs = options.pageWaitMs ?? DEFAULT_PAGE_WAIT_MS
    this.#onGone = options.onGone
  }

  static async attach(options: SlaveOptions): Promise<SlaveMirror> {
    let browser: BrowserLike
    try {
      browser = await options.connect(options.wsEndpoint)
    } catch (error) {
      throw new SyncError(
        `could not attach to slave profile "${options.label}": ${message(error)}`,
        'attach_failed',
      )
    }
    const context = browser.contexts()[0]
    if (!context) {
      throw new SyncError(
        `slave profile "${options.label}" exposed no browser context to attach to`,
        'attach_failed',
      )
    }

    const slave = new SlaveMirror(options, browser, context)
    context.on('page', slave.#onPage)
    browser.on('disconnected', slave.#onDisconnected)
    const page = slave.#pickPage()
    if (page) {
      slave.#setPage(page)
    }
    return slave
  }

  get dropped(): SlaveDropped {
    return { ...this.#dropped }
  }

  /** Queue one event for replay. Never awaits, never throws, never blocks the master. */
  enqueue(event: MirrorEvent): void {
    if (this.#stopped) {
      return
    }
    if (event.kind === 'mousemove' && this.#queue.length >= this.#limits.moves) {
      this.#dropped.moves += 1
      return
    }
    if (this.#queue.length >= this.#limits.queue) {
      const index = this.#queue.findIndex(queued => queued.kind === 'mousemove')
      if (index >= 0) {
        this.#queue.splice(index, 1)
        this.#dropped.moves += 1
      } else if (event.kind === 'mousemove') {
        this.#dropped.moves += 1
        return
      } else {
        this.#dropped.critical += 1
        if (!this.#warnedFull) {
          this.#warnedFull = true
          this.#logger.warn(
            `sync: slave "${this.profileId}" is not keeping up — input is being dropped`,
          )
        }
        return
      }
    }
    this.#queue.push(event)
    this.#startDrain()
  }

  /** Stop replaying and detach. The slave browser and its window keep running. */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return
    }
    this.#stopped = true
    this.#queue.length = 0
    for (const waiter of this.#waiters.splice(0)) {
      waiter(null)
    }
    try {
      this.#context.off('page', this.#onPage)
      this.#browser.off('disconnected', this.#onDisconnected)
      this.#page?.off('close', this.#onPageClose)
    } catch (error) {
      this.#logger.debug(`sync: detaching slave listeners failed: ${message(error)}`)
    }
    this.#page = null
    if (this.#draining) {
      await this.#draining
    }
    try {
      await this.#browser.close()
    } catch (error) {
      this.#logger.warn(`sync: closing the slave connection failed: ${message(error)}`)
    }
  }

  #setPage(page: PageLike): void {
    if (this.#page !== page) {
      this.#page?.off('close', this.#onPageClose)
      this.#page = page
      page.on('close', this.#onPageClose)
    }
    for (const waiter of this.#waiters.splice(0)) {
      waiter(page)
    }
  }

  #pickPage(): PageLike | null {
    try {
      const pages = this.#context.pages().filter(page => !page.isClosed())
      return pages[pages.length - 1] ?? null
    } catch {
      return null
    }
  }

  #startDrain(): void {
    if (this.#draining) {
      return
    }
    const drain = this.#drain()
    this.#draining = drain
    void drain.then(() => {
      if (this.#draining === drain) {
        this.#draining = null
      }
    })
  }

  async #drain(): Promise<void> {
    while (!this.#stopped && this.#queue.length > 0) {
      const event = this.#queue.shift()
      if (!event) {
        break
      }
      const page = await this.#acquirePage()
      if (!page) {
        // No window to replay into. Replaying a backlog later would fire clicks into a document
        // state that has moved on, so the backlog is discarded rather than replayed late.
        const dropped = this.#queue.length + 1
        this.#queue.length = 0
        this.#dropped.noPage += dropped
        this.#logger.warn(
          `sync: slave "${this.profileId}" has no page — dropped ${dropped} event(s)`,
        )
        break
      }
      try {
        const viewport = await this.#viewports.get(page)
        await replayEvent(page, event, viewport, this.#replay)
      } catch (error) {
        this.#logger.warn(`sync: replay into slave "${this.profileId}" failed: ${message(error)}`)
      }
    }
  }

  async #acquirePage(): Promise<PageLike | null> {
    if (this.#stopped) {
      return null
    }
    const current = this.#page
    if (current && !current.isClosed()) {
      return current
    }
    const existing = this.#pickPage()
    if (existing) {
      this.#setPage(existing)
      return existing
    }
    return await new Promise<PageLike | null>(resolve => {
      const waiter = (page: PageLike | null): void => {
        clearTimeout(timer)
        resolve(page)
      }
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(pending => pending !== waiter)
        resolve(null)
      }, this.#pageWaitMs)
      timer.unref()
      this.#waiters.push(waiter)
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
