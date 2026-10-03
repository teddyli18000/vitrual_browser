/**
 * The master → Node transport and the slave-side replay.
 *
 * A small script is installed into the master window (as an init script, so it survives
 * navigations, plus once into the document that is already open). It reports a compact stream of
 * real input events through an exposed binding. Playwright's own input APIs then replay those
 * events into the slave pages, where they are indistinguishable from real input.
 *
 * Two properties matter and are enforced here:
 *
 * 1. **A slave can never be a source.** The listener is only ever installed in the master's
 *    context, and the binding lives only in that context. On top of that the listener drops
 *    events whose `isTrusted` is false, so a page script cannot forge input, and the session
 *    drops any report whose source profile is not the active master.
 * 2. **The master is never blocked.** The binding callback enqueues and returns immediately;
 *    it never awaits a slave.
 */

import type { MouseButton, PageLike, ViewportSize } from './browser.js'
import { mapPoint } from './mapping.js'

export const SYNC_BINDING_NAME = '__vfoxSyncReport'

/** Throttle for `mousemove` inside the page; the other events are never throttled. */
const MOVE_INTERVAL_MS = 16

/** One `DOM_DELTA_LINE` step, used when a wheel event is not reported in pixels. */
export const WHEEL_LINE_HEIGHT_PX = 16

export type MirrorEventKind =
  | 'mousedown'
  | 'mouseup'
  | 'click'
  | 'wheel'
  | 'keydown'
  | 'keyup'
  | 'mousemove'

export interface MirrorEvent {
  kind: MirrorEventKind
  x: number
  y: number
  /** `MouseEvent.button` (0 left, 1 middle, 2 right). */
  button: number
  deltaX: number
  deltaY: number
  /** `WheelEvent.deltaMode` (0 pixels, 1 lines, 2 pages). */
  deltaMode: number
  /** `KeyboardEvent.key`. */
  key: string
  /** `KeyboardEvent.repeat`. */
  repeat: boolean
  /** Master viewport at the moment the event fired. */
  viewport: ViewportSize
}

const MOUSE_KINDS = new Set<MirrorEventKind>([
  'mousedown',
  'mouseup',
  'click',
  'wheel',
  'mousemove',
])
const EVENT_KINDS = new Set<string>([...MOUSE_KINDS, 'keydown', 'keyup'])

/**
 * Installed into the master window. Written as a string because it must run in the page, in every
 * frame and before page scripts; the `__vfoxSyncInstalled` guard makes re-installation a no-op.
 */
export const SYNC_LISTENER_SOURCE = `(() => {
  const w = window
  if (w.__vfoxSyncInstalled) return
  if (w.top !== w) return
  w.__vfoxSyncInstalled = true
  let lastMove = 0
  const report = payload => {
    const fn = w.__vfoxSyncReport
    if (typeof fn !== 'function') return
    try { fn(payload) } catch (error) { /* a failed report must never disturb the master */ }
  }
  const base = evt => ({ x: evt.clientX, y: evt.clientY, vw: w.innerWidth, vh: w.innerHeight })
  const mouse = (kind, evt) => {
    if (!evt.isTrusted) return
    report(Object.assign({ kind: kind, button: evt.button }, base(evt)))
  }
  const wheel = evt => {
    if (!evt.isTrusted) return
    report(Object.assign({
      kind: 'wheel',
      deltaX: evt.deltaX,
      deltaY: evt.deltaY,
      deltaMode: evt.deltaMode
    }, base(evt)))
  }
  const key = (kind, evt) => {
    if (!evt.isTrusted) return
    report(Object.assign({ kind: kind, key: evt.key, repeat: evt.repeat }, base(evt)))
  }
  const move = evt => {
    if (!evt.isTrusted) return
    const now = Date.now()
    if (now - lastMove < ${MOVE_INTERVAL_MS}) return
    lastMove = now
    mouse('mousemove', evt)
  }
  const listeners = [
    ['mousedown', evt => mouse('mousedown', evt)],
    ['mouseup', evt => mouse('mouseup', evt)],
    ['click', evt => mouse('click', evt)],
    ['mousemove', move],
    ['wheel', wheel],
    ['keydown', evt => key('keydown', evt)],
    ['keyup', evt => key('keyup', evt)]
  ]
  for (const [type, handler] of listeners) w.addEventListener(type, handler, true)
  w.__vfoxSyncTeardown = () => {
    for (const [type, handler] of listeners) w.removeEventListener(type, handler, true)
    w.__vfoxSyncInstalled = false
    delete w.__vfoxSyncTeardown
  }
})()`

/** Removes the listeners the source above installed in an already-open document. */
export const SYNC_TEARDOWN_SOURCE =
  "(() => { const off = window.__vfoxSyncTeardown; if (typeof off === 'function') off() })()"

/** Normalise whatever a page reported; anything unrecognisable is dropped, never replayed. */
export function normalizeMirrorEvent(payload: unknown): MirrorEvent | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const raw = payload as Record<string, unknown>
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!EVENT_KINDS.has(kind)) {
    return null
  }
  const viewport = normalizeSize(raw.vw, raw.vh)
  if (!viewport) {
    return null
  }
  const isMouse = MOUSE_KINDS.has(kind as MirrorEventKind)
  if (isMouse && (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y))) {
    return null
  }
  return {
    kind: kind as MirrorEventKind,
    x: isFiniteNumber(raw.x) ? raw.x : 0,
    y: isFiniteNumber(raw.y) ? raw.y : 0,
    button: isFiniteNumber(raw.button) ? raw.button : 0,
    deltaX: isFiniteNumber(raw.deltaX) ? raw.deltaX : 0,
    deltaY: isFiniteNumber(raw.deltaY) ? raw.deltaY : 0,
    deltaMode: isFiniteNumber(raw.deltaMode) ? raw.deltaMode : 0,
    key: typeof raw.key === 'string' ? raw.key : '',
    repeat: raw.repeat === true,
    viewport,
  }
}

/** Per-page replay state: which buttons already received their full down+up pair. */
export interface ReplayState {
  readonly paired: Set<number>
}

export function createReplayState(): ReplayState {
  return { paired: new Set() }
}

/**
 * Replay one master event into a slave page.
 *
 * `click` is not replayed on its own when its `mousedown`/`mouseup` pair already went through:
 * the engine synthesises the click from those two, and replaying it as well would double it. It
 * is replayed when the pair did *not* arrive — the events were dropped, or the slave only got its
 * page afterwards — so the action still happens.
 */
export async function replayEvent(
  page: PageLike,
  event: MirrorEvent,
  viewport: ViewportSize,
  state: ReplayState,
): Promise<void> {
  switch (event.kind) {
    case 'mousemove': {
      const point = mapPoint(event, event.viewport, viewport)
      await page.mouse.move(point.x, point.y)
      return
    }
    case 'mousedown': {
      const button = buttonName(event.button)
      if (!button) {
        return
      }
      const point = mapPoint(event, event.viewport, viewport)
      await page.mouse.move(point.x, point.y)
      await page.mouse.down({ button })
      state.paired.delete(event.button)
      return
    }
    case 'mouseup': {
      const button = buttonName(event.button)
      if (!button) {
        return
      }
      const point = mapPoint(event, event.viewport, viewport)
      await page.mouse.move(point.x, point.y)
      await page.mouse.up({ button })
      state.paired.add(event.button)
      return
    }
    case 'click': {
      const button = buttonName(event.button)
      if (!button) {
        return
      }
      if (state.paired.delete(event.button)) {
        return
      }
      const point = mapPoint(event, event.viewport, viewport)
      await page.mouse.move(point.x, point.y)
      await page.mouse.click(point.x, point.y, { button })
      return
    }
    case 'wheel': {
      const point = mapPoint(event, event.viewport, viewport)
      const scale =
        event.deltaMode === 1
          ? WHEEL_LINE_HEIGHT_PX
          : event.deltaMode === 2
            ? Math.max(1, viewport.height)
            : 1
      await page.mouse.move(point.x, point.y)
      await page.mouse.wheel(event.deltaX * scale, event.deltaY * scale)
      return
    }
    case 'keydown': {
      const key = keyName(event)
      if (key) {
        await page.keyboard.down(key)
      }
      return
    }
    case 'keyup': {
      const key = keyName(event)
      if (key) {
        await page.keyboard.up(key)
      }
      return
    }
    default:
      return
  }
}

function buttonName(button: number): MouseButton | null {
  switch (button) {
    case 0:
      return 'left'
    case 1:
      return 'middle'
    case 2:
      return 'right'
    default:
      return null
  }
}

/** Keys Playwright cannot replay meaningfully, plus IME placeholders. */
const UNREPLAYABLE_KEYS = new Set(['', 'Unidentified', 'Process', 'Dead'])

function keyName(event: MirrorEvent): string | null {
  return UNREPLAYABLE_KEYS.has(event.key) ? null : event.key
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeSize(width: unknown, height: unknown): ViewportSize | null {
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null
  }
  if (width <= 0 || height <= 0) {
    return null
  }
  return { width: Math.floor(width), height: Math.floor(height) }
}
