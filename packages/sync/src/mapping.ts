/**
 * Coordinate mapping between two windows.
 *
 * The master and the slave are separate browser windows with independent sizes, so an input event
 * is mapped by the viewport ratio and then clamped: Playwright rejects coordinates outside the
 * viewport, and a click at the far edge of a larger master window would otherwise land outside a
 * smaller slave window and be dropped by the engine.
 */

import type { PageLike, ViewportSize } from './browser.js'

export interface Point {
  x: number
  y: number
}

/**
 * Read the slave's viewport without blocking on it for every event.
 *
 * The engine launches persistent contexts with `noDefaultViewport`, so `page.viewportSize()`
 * returns `null` and the real size only exists in the page (`window.innerWidth/innerHeight`).
 * That costs a round trip, which is why the result is cached for a short window: replaying input
 * is on the hot path and a one-second-old viewport is still correct unless the user is dragging a
 * window edge at that exact moment.
 */
export class ViewportTracker {
  static readonly DEFAULT_TTL_MS = 1000

  readonly #now: () => number
  readonly #ttlMs: number
  readonly #cache = new WeakMap<PageLike, { size: ViewportSize; at: number }>()

  constructor(now: () => number = Date.now, ttlMs: number = ViewportTracker.DEFAULT_TTL_MS) {
    this.#now = now
    this.#ttlMs = ttlMs
  }

  async get(page: PageLike): Promise<ViewportSize> {
    const fixed = normalizeViewport(page.viewportSize())
    if (fixed) {
      return fixed
    }

    const cached = this.#cache.get(page)
    if (cached && this.#now() - cached.at < this.#ttlMs) {
      return cached.size
    }

    try {
      const measured = normalizeViewport(
        await page.evaluate<ViewportSize>(
          '({ width: window.innerWidth, height: window.innerHeight })',
        ),
      )
      if (measured) {
        this.#cache.set(page, { size: measured, at: this.#now() })
        return measured
      }
    } catch (error) {
      // A navigating or closing page cannot answer; the last known size still maps correctly.
      if (!cached) {
        throw error
      }
    }

    if (cached) {
      return cached.size
    }
    throw new Error('page reported no usable viewport')
  }
}

/** Map a point from one viewport onto another, rounding and clamping into the target. */
export function mapPoint(point: Point, from: ViewportSize, to: ViewportSize): Point {
  const scaleX = from.width > 0 ? to.width / from.width : 1
  const scaleY = from.height > 0 ? to.height / from.height : 1
  return clampPoint(point.x * scaleX, point.y * scaleY, to)
}

export function clampPoint(x: number, y: number, to: ViewportSize): Point {
  const maxX = Math.max(0, to.width - 1)
  const maxY = Math.max(0, to.height - 1)
  return {
    x: clamp(Math.round(Number.isFinite(x) ? x : 0), maxX),
    y: clamp(Math.round(Number.isFinite(y) ? y : 0), maxY),
  }
}

export function normalizeViewport(size: ViewportSize | null | undefined): ViewportSize | null {
  if (!size) {
    return null
  }
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return null
  }
  if (size.width <= 0 || size.height <= 0) {
    return null
  }
  return { width: Math.floor(size.width), height: Math.floor(size.height) }
}

function clamp(value: number, max: number): number {
  if (value < 0) {
    return 0
  }
  return value > max ? max : value
}
