import { describe, expect, it } from 'vitest'

interface ViewportView {
  osRect: { width: number; height: number }
  innerWidth: number
  innerHeight: number
  devicePixelRatio?: number
}

interface Verdict {
  ok: boolean
  failures: string[]
  chrome: { width: number; height: number }
}

/**
 * A non-literal specifier on purpose. The guard is plain JavaScript in `scripts/lib`, deliberately
 * outside the TypeScript build (it is consumed by `verify-window.mjs`, not by the package), so the path
 * is resolved at runtime instead of by the compiler.
 */
const moduleUrl = new URL('../../scripts/lib/window-geometry.mjs', import.meta.url).href
const { checkViewportAgainstOs } = (await import(moduleUrl)) as {
  checkViewportAgainstOs: (view: ViewportView) => Verdict
}

/** The live geometry from CI run 37266596880: a real window, reported by Firefox itself. */
const REAL: ViewportView = {
  osRect: { width: 1786, height: 1311 },
  innerWidth: 1770,
  innerHeight: 1246,
  devicePixelRatio: 1,
}

describe('checkViewportAgainstOs', () => {
  it('accepts the geometry a real window reported', () => {
    const verdict = checkViewportAgainstOs(REAL)

    expect(verdict.ok).toBe(true)
    expect(verdict.chrome).toEqual({ width: 16, height: 65 })
  })

  it('is scale-aware, so a scaled display is not failed spuriously', () => {
    const verdict = checkViewportAgainstOs({
      osRect: { width: 2233, height: 1639 },
      innerWidth: 1770,
      innerHeight: 1246,
      devicePixelRatio: 1.25,
    })

    expect(verdict.ok).toBe(true)
  })

  it('fails when the viewport is smaller than the window by more than chrome allows', () => {
    const verdict = checkViewportAgainstOs({ ...REAL, innerHeight: 1046 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toContain('265px of chrome')
  })

  it('fails when the viewport is larger than the window that contains it', () => {
    expect(checkViewportAgainstOs({ ...REAL, innerHeight: 1446 }).ok).toBe(false)
    expect(checkViewportAgainstOs({ ...REAL, innerWidth: 1970 }).ok).toBe(false)
  })

  it('fails a zero viewport, which is the defect it was written for', () => {
    const verdict = checkViewportAgainstOs({ ...REAL, innerWidth: 0, innerHeight: 0 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('0x0 viewport')
  })

  it('cannot catch a plausible but wrong viewport — documented so nobody tightens the band', () => {
    // A 1920x970 window whose viewport was derived as `outer - 16/90`. Every number is internally
    // consistent, so geometry alone cannot distinguish it from the true 16x65 measurement above. This
    // is asserted rather than described because it is the reason the viewport must be left to the
    // browser: no band narrow enough to catch this is honest about real browser chrome.
    const verdict = checkViewportAgainstOs({
      osRect: { width: 1920, height: 970 },
      innerWidth: 1904,
      innerHeight: 880,
      devicePixelRatio: 1,
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.chrome).toEqual({ width: 16, height: 90 })
  })
})
