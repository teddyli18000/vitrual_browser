/**
 * The narrow slice of Playwright the synchroniser drives, plus the one real adapter.
 *
 * Mirroring only works against a real browser, but everything that actually breaks — queueing,
 * coordinate mapping, back-pressure, feedback-loop guards, detach on stop — does not need a
 * browser to be exercised. Every module below therefore codes against these structural
 * interfaces, and `connectBrowser` is the only place playwright-core is touched.
 *
 * The cast in `connectBrowser` is the deliberate anti-corruption boundary: `Page` and
 * `BrowserContext` expose a far wider surface than this package uses, and it changes shape
 * between Playwright releases, which are pinned exactly for the engine's sake.
 */

import { firefox } from 'playwright-core'

export type MouseButton = 'left' | 'middle' | 'right'

export interface ViewportSize {
  width: number
  height: number
}

/** Playwright's `Disposable`: removes the resource a call installed. */
export interface Disposable {
  dispose(): Promise<void>
}

export interface MouseLike {
  move(x: number, y: number): Promise<void>
  down(options?: { button?: MouseButton }): Promise<void>
  up(options?: { button?: MouseButton }): Promise<void>
  click(
    x: number,
    y: number,
    options?: { button?: MouseButton; clickCount?: number },
  ): Promise<void>
  wheel(deltaX: number, deltaY: number): Promise<void>
}

export interface KeyboardLike {
  down(key: string): Promise<void>
  up(key: string): Promise<void>
}

export interface PageLike {
  readonly mouse: MouseLike
  readonly keyboard: KeyboardLike
  /** `null` for a persistent-context window (the engine runs with `noDefaultViewport`). */
  viewportSize(): ViewportSize | null
  evaluate<T>(expression: string): Promise<T>
  isClosed(): boolean
  on(event: 'close', listener: () => void): unknown
  off(event: 'close', listener: () => void): unknown
}

/** First argument Playwright hands to an exposed binding. */
export interface BindingSourceLike {
  page: PageLike
}

export interface ContextLike {
  pages(): PageLike[]
  exposeBinding(
    name: string,
    callback: (source: BindingSourceLike, payload: unknown) => unknown,
  ): Promise<Disposable>
  /** Applies to every document created in this context from now on. */
  addInitScript(script: string): Promise<Disposable>
  on(event: 'page', listener: (page: PageLike) => void): unknown
  off(event: 'page', listener: (page: PageLike) => void): unknown
}

export interface BrowserLike {
  contexts(): ContextLike[]
  /** On a *connected* browser this closes the connection, not the user's window. */
  close(): Promise<void>
  on(event: 'disconnected', listener: () => void): unknown
  off(event: 'disconnected', listener: () => void): unknown
}

export type BrowserConnector = (wsEndpoint: string) => Promise<BrowserLike>

export const connectBrowser: BrowserConnector = async wsEndpoint => {
  const browser = await firefox.connect(wsEndpoint)
  return browser as unknown as BrowserLike
}
