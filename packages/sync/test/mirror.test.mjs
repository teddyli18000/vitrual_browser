import { describe, expect, it } from 'vitest'
import {
  createReplayState,
  normalizeMirrorEvent,
  replayEvent,
  SYNC_LISTENER_SOURCE,
  SYNC_TEARDOWN_SOURCE,
  WHEEL_LINE_HEIGHT_PX,
} from '../dist/mirror.js'
import { FakePage, keyPayload, mousePayload } from './helpers/fake-browser.mjs'

/* ---------------------------------------------------------------- injected page listener */

function createWindow(report) {
  const reported = []
  const listeners = new Map()
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    top: undefined,
    __vfoxSyncReport: payload => {
      reported.push(payload)
      report?.(payload)
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? new Set()
      handlers.add(handler)
      listeners.set(type, handlers)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) {
        handler(event)
      }
    },
    listenerCount() {
      let total = 0
      for (const handlers of listeners.values()) {
        total += handlers.size
      }
      return total
    },
  }
  win.top = win
  return { win, reported }
}

function install(win) {
  // The source is a string because it runs inside the page; running it against a fake window is
  // the only way to test it without a browser.
  new Function('window', SYNC_LISTENER_SOURCE)(win)
}

function teardown(win) {
  new Function('window', SYNC_TEARDOWN_SOURCE)(win)
}

const trusted = extra => ({
  isTrusted: true,
  clientX: 10,
  clientY: 20,
  button: 0,
  ...extra,
})

describe('the injected master listener', () => {
  it('reports trusted mouse input with the viewport it happened in', () => {
    const { win, reported } = createWindow()
    install(win)

    win.dispatch('mousedown', trusted({}))
    win.dispatch('mouseup', trusted({}))
    win.dispatch('click', trusted({}))

    expect(reported).toEqual([
      { kind: 'mousedown', button: 0, x: 10, y: 20, vw: 1280, vh: 800 },
      { kind: 'mouseup', button: 0, x: 10, y: 20, vw: 1280, vh: 800 },
      { kind: 'click', button: 0, x: 10, y: 20, vw: 1280, vh: 800 },
    ])
  })

  it('reports wheel deltas with their unit', () => {
    const { win, reported } = createWindow()
    install(win)

    win.dispatch('wheel', trusted({ deltaX: 0, deltaY: 120, deltaMode: 0 }))

    expect(reported).toEqual([
      { kind: 'wheel', deltaX: 0, deltaY: 120, deltaMode: 0, x: 10, y: 20, vw: 1280, vh: 800 },
    ])
  })

  it('reports key events, including repeats', () => {
    const { win, reported } = createWindow()
    install(win)

    win.dispatch('keydown', trusted({ key: 'a', repeat: false }))
    win.dispatch('keydown', trusted({ key: 'a', repeat: true }))
    win.dispatch('keyup', trusted({ key: 'a', repeat: false }))

    expect(reported).toEqual([
      { kind: 'keydown', key: 'a', repeat: false, x: 10, y: 20, vw: 1280, vh: 800 },
      { kind: 'keydown', key: 'a', repeat: true, x: 10, y: 20, vw: 1280, vh: 800 },
      { kind: 'keyup', key: 'a', repeat: false, x: 10, y: 20, vw: 1280, vh: 800 },
    ])
  })

  it('ignores events a page script forged, so input cannot be faked', () => {
    const { win, reported } = createWindow()
    install(win)

    win.dispatch('mousedown', trusted({ isTrusted: false }))
    win.dispatch('click', trusted({ isTrusted: false }))
    win.dispatch('keydown', trusted({ isTrusted: false, key: 'a' }))
    win.dispatch('wheel', trusted({ isTrusted: false, deltaY: 10 }))

    expect(reported).toEqual([])
  })

  it('stays out of iframes, whose coordinates are frame-relative', () => {
    const { win, reported } = createWindow()
    win.top = {}
    install(win)

    win.dispatch('click', trusted({}))

    expect(win.__vfoxSyncInstalled).toBeUndefined()
    expect(reported).toEqual([])
  })

  it('throttles mousemove but never the events that carry an action', () => {
    const { win, reported } = createWindow()
    install(win)

    win.dispatch('mousemove', trusted({ clientX: 1 }))
    win.dispatch('mousemove', trusted({ clientX: 2 }))
    win.dispatch('mousemove', trusted({ clientX: 3 }))
    win.dispatch('mousedown', trusted({ clientX: 4 }))

    expect(reported.map(payload => payload.kind)).toEqual(['mousemove', 'mousedown'])
  })

  it('installs once, even when the init script runs again after a navigation', () => {
    const { win, reported } = createWindow()
    install(win)
    install(win)

    win.dispatch('click', trusted({}))

    expect(reported).toHaveLength(1)
    expect(win.listenerCount()).toBe(7)
  })

  it('tears down every listener it installed', () => {
    const { win, reported } = createWindow()
    install(win)
    expect(win.listenerCount()).toBe(7)

    teardown(win)

    expect(win.listenerCount()).toBe(0)
    expect(win.__vfoxSyncInstalled).toBe(false)
    win.dispatch('click', trusted({}))
    expect(reported).toEqual([])
  })

  it('survives a transport that throws', () => {
    const { win } = createWindow(() => {
      throw new Error('binding removed')
    })
    install(win)

    expect(() => win.dispatch('click', trusted({}))).not.toThrow()
  })
})

/* --------------------------------------------------------------------------- normalisation */

describe('normalizeMirrorEvent', () => {
  it('accepts a well-formed mouse report', () => {
    expect(normalizeMirrorEvent(mousePayload('mousedown', 10, 20, { button: 2 }))).toEqual({
      kind: 'mousedown',
      x: 10,
      y: 20,
      button: 2,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      key: '',
      repeat: false,
      viewport: { width: 1280, height: 800 },
    })
  })

  it('accepts a key report without coordinates', () => {
    const event = normalizeMirrorEvent(keyPayload('keydown', 'Enter', { repeat: true }))
    expect(event?.kind).toBe('keydown')
    expect(event?.key).toBe('Enter')
    expect(event?.repeat).toBe(true)
  })

  it('rejects anything it does not recognise', () => {
    expect(normalizeMirrorEvent(null)).toBeNull()
    expect(normalizeMirrorEvent('mousedown')).toBeNull()
    expect(normalizeMirrorEvent({ kind: 'dragstart', vw: 100, vh: 100 })).toBeNull()
    expect(normalizeMirrorEvent(mousePayload('click', 1, 2, { vw: 0 }))).toBeNull()
    expect(normalizeMirrorEvent(mousePayload('click', Number.NaN, 2))).toBeNull()
    expect(normalizeMirrorEvent({ kind: 'mousemove', vw: 1280, vh: 800 })).toBeNull()
  })
})

/* --------------------------------------------------------------------------------- replay */

function methods(page) {
  return page.calls.map(call => call.method)
}

describe('replayEvent', () => {
  const master = { width: 1280, height: 800 }

  it('moves the pointer using the mapped coordinates', async () => {
    const page = new FakePage()
    const event = normalizeMirrorEvent(mousePayload('mousemove', 640, 400))
    if (!event) throw new Error('expected a normalised event')

    await replayEvent(page, event, { width: 640, height: 400 }, createReplayState())

    expect(page.calls).toEqual([{ method: 'move', args: [320, 200] }])
  })

  it('moves before pressing, so a click never lands where the last move happened to be', async () => {
    const page = new FakePage()
    const event = normalizeMirrorEvent(mousePayload('mousedown', 100, 200))
    if (!event) throw new Error('expected a normalised event')

    await replayEvent(page, event, master, createReplayState())

    expect(page.calls).toEqual([
      { method: 'move', args: [100, 200] },
      { method: 'down', args: [{ button: 'left' }] },
    ])
  })

  it('maps the right and middle buttons', async () => {
    const right = normalizeMirrorEvent(mousePayload('mousedown', 1, 1, { button: 2 }))
    const middle = normalizeMirrorEvent(mousePayload('mousedown', 1, 1, { button: 1 }))
    if (!right || !middle) throw new Error('expected normalised events')
    const page = new FakePage()

    await replayEvent(page, right, master, createReplayState())
    await replayEvent(page, middle, master, createReplayState())

    expect(page.calls).toEqual([
      { method: 'move', args: [1, 1] },
      { method: 'down', args: [{ button: 'right' }] },
      { method: 'move', args: [1, 1] },
      { method: 'down', args: [{ button: 'middle' }] },
    ])
  })

  it('ignores a button Playwright cannot express', async () => {
    const event = normalizeMirrorEvent(mousePayload('mousedown', 1, 1, { button: 4 }))
    if (!event) throw new Error('expected a normalised event')
    const page = new FakePage()

    await replayEvent(page, event, master, createReplayState())

    expect(page.calls).toEqual([])
  })

  it('does not replay a click whose down+up pair already went through', async () => {
    const page = new FakePage()
    const state = createReplayState()
    const down = normalizeMirrorEvent(mousePayload('mousedown', 5, 5))
    const up = normalizeMirrorEvent(mousePayload('mouseup', 5, 5))
    const click = normalizeMirrorEvent(mousePayload('click', 5, 5))
    if (!down || !up || !click) throw new Error('expected normalised events')

    await replayEvent(page, down, master, state)
    await replayEvent(page, up, master, state)
    await replayEvent(page, click, master, state)

    expect(methods(page)).toEqual(['move', 'down', 'move', 'up'])
  })

  it('replays a click that arrived without its pair, so the action still happens', async () => {
    const page = new FakePage()
    const click = normalizeMirrorEvent(mousePayload('click', 7, 9))
    if (!click) throw new Error('expected a normalised event')

    await replayEvent(page, click, master, createReplayState())

    expect(page.calls).toEqual([
      { method: 'move', args: [7, 9] },
      { method: 'click', args: [7, 9, { button: 'left' }] },
    ])
  })

  it('passes wheel deltas through when they are already pixels', async () => {
    const page = new FakePage()
    const event = normalizeMirrorEvent(mousePayload('wheel', 10, 10, { deltaX: 3, deltaY: 120 }))
    if (!event) throw new Error('expected a normalised event')

    await replayEvent(page, event, master, createReplayState())

    expect(page.calls).toEqual([
      { method: 'move', args: [10, 10] },
      { method: 'wheel', args: [3, 120] },
    ])
  })

  it('converts line- and page-mode wheel deltas into pixels', async () => {
    const page = new FakePage()
    const lines = normalizeMirrorEvent(
      mousePayload('wheel', 0, 0, { deltaY: 3, deltaMode: 1, vw: 100, vh: 100 }),
    )
    const pages = normalizeMirrorEvent(
      mousePayload('wheel', 0, 0, { deltaY: 1, deltaMode: 2, vw: 100, vh: 100 }),
    )
    if (!lines || !pages) throw new Error('expected normalised events')

    await replayEvent(page, lines, { width: 100, height: 100 }, createReplayState())
    await replayEvent(page, pages, { width: 100, height: 100 }, createReplayState())

    expect(page.calls).toEqual([
      { method: 'move', args: [0, 0] },
      { method: 'wheel', args: [0, 3 * WHEEL_LINE_HEIGHT_PX] },
      { method: 'move', args: [0, 0] },
      { method: 'wheel', args: [0, 100] },
    ])
  })

  it('replays key down and key up with the DOM key name', async () => {
    const page = new FakePage()
    const down = normalizeMirrorEvent(keyPayload('keydown', 'ArrowLeft'))
    const up = normalizeMirrorEvent(keyPayload('keyup', 'ArrowLeft'))
    if (!down || !up) throw new Error('expected normalised events')

    await replayEvent(page, down, master, createReplayState())
    await replayEvent(page, up, master, createReplayState())

    expect(page.calls).toEqual([
      { method: 'key-down', args: ['ArrowLeft'] },
      { method: 'key-up', args: ['ArrowLeft'] },
    ])
  })

  it('skips keys that cannot be replayed', async () => {
    const page = new FakePage()
    for (const key of ['Unidentified', 'Process', 'Dead', '']) {
      const event = normalizeMirrorEvent(keyPayload('keydown', key))
      if (!event) throw new Error('expected a normalised event')
      await replayEvent(page, event, master, createReplayState())
    }

    expect(page.calls).toEqual([])
  })
})
