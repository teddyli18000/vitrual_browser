import { describe, expect, it } from 'vitest'
import { clampPoint, mapPoint, normalizeViewport, ViewportTracker } from '../dist/mapping.js'
import { FakePage } from './helpers/fake-browser.mjs'

describe('mapPoint', () => {
  it('is the identity when master and slave have the same viewport', () => {
    const viewport = { width: 1280, height: 800 }
    expect(mapPoint({ x: 100, y: 50 }, viewport, viewport)).toEqual({ x: 100, y: 50 })
  })

  it('scales up into a larger slave window', () => {
    expect(
      mapPoint({ x: 100, y: 100 }, { width: 1000, height: 500 }, { width: 2000, height: 1000 }),
    ).toEqual({ x: 200, y: 200 })
  })

  it('scales down into a smaller slave window', () => {
    expect(
      mapPoint({ x: 640, y: 400 }, { width: 1280, height: 800 }, { width: 640, height: 400 }),
    ).toEqual({ x: 320, y: 200 })
  })

  it('scales each axis independently when the aspect ratios differ', () => {
    expect(
      mapPoint({ x: 800, y: 600 }, { width: 1600, height: 900 }, { width: 400, height: 900 }),
    ).toEqual({ x: 200, y: 600 })
  })

  it('rounds to whole pixels', () => {
    expect(
      mapPoint({ x: 100.6, y: 0.4 }, { width: 1000, height: 1000 }, { width: 1000, height: 1000 }),
    ).toEqual({ x: 101, y: 0 })
  })

  it('clamps a point past the far edge into the slave viewport', () => {
    expect(
      mapPoint({ x: 5000, y: 5000 }, { width: 1000, height: 1000 }, { width: 800, height: 600 }),
    ).toEqual({ x: 799, y: 599 })
  })

  it('clamps negative coordinates to the origin', () => {
    expect(
      mapPoint({ x: -50, y: -50 }, { width: 1000, height: 1000 }, { width: 800, height: 600 }),
    ).toEqual({ x: 0, y: 0 })
  })

  it('does not produce NaN when the master reported an empty viewport', () => {
    expect(
      mapPoint({ x: 120, y: 90 }, { width: 0, height: 0 }, { width: 800, height: 600 }),
    ).toEqual({ x: 120, y: 90 })
  })

  it('never leaves the target viewport, even for a one-pixel target', () => {
    expect(clampPoint(999, 999, { width: 1, height: 1 })).toEqual({ x: 0, y: 0 })
  })
})

describe('normalizeViewport', () => {
  it('rejects null, empty and non-finite sizes', () => {
    expect(normalizeViewport(null)).toBeNull()
    expect(normalizeViewport({ width: 0, height: 800 })).toBeNull()
    expect(normalizeViewport({ width: 1280, height: Number.NaN })).toBeNull()
  })

  it('floors a fractional size', () => {
    expect(normalizeViewport({ width: 1280.7, height: 800.2 })).toEqual({
      width: 1280,
      height: 800,
    })
  })
})

describe('ViewportTracker', () => {
  it('uses a fixed viewport without asking the page', async () => {
    const page = new FakePage({ fixedViewport: { width: 800, height: 600 } })
    const tracker = new ViewportTracker()
    expect(await tracker.get(page)).toEqual({ width: 800, height: 600 })
    expect(page.evaluated).toHaveLength(0)
  })

  it('measures a persistent-context window once and caches it', async () => {
    let clock = 0
    const tracker = new ViewportTracker(() => clock, 1000)
    const page = new FakePage({ measured: { width: 1024, height: 768 } })

    expect(await tracker.get(page)).toEqual({ width: 1024, height: 768 })
    page.setMeasuredViewport({ width: 640, height: 480 })

    clock = 500
    expect(await tracker.get(page)).toEqual({ width: 1024, height: 768 })

    clock = 1000
    expect(await tracker.get(page)).toEqual({ width: 640, height: 480 })
    expect(page.evaluated.filter(expression => expression.includes('innerWidth'))).toHaveLength(2)
  })

  it('keeps the last known size when the page cannot answer mid-navigation', async () => {
    let clock = 0
    const tracker = new ViewportTracker(() => clock, 1000)
    const page = new FakePage({ measured: { width: 1024, height: 768 } })

    expect(await tracker.get(page)).toEqual({ width: 1024, height: 768 })
    clock = 5000
    page.failEvaluate = 'Execution context was destroyed'

    expect(await tracker.get(page)).toEqual({ width: 1024, height: 768 })
  })

  it('propagates the reason a page could not answer at all', async () => {
    const page = new FakePage()
    page.failEvaluate = 'Target page, context or browser has been closed'
    await expect(new ViewportTracker().get(page)).rejects.toThrow(
      'Target page, context or browser has been closed',
    )
  })

  it('refuses a page that reports an empty viewport', async () => {
    const page = new FakePage({ measured: { width: 0, height: 0 } })
    await expect(new ViewportTracker().get(page)).rejects.toThrow('no usable viewport')
  })
})
