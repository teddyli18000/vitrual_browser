/**
 * Window tiling: arrange the real OS windows of the given profiles on a monitor.
 *
 * Playwright drives page content and cannot touch a native window, so this layer calls
 * `user32.dll` through koffi — a prebuilt napi FFI, no compiler and no native build step.
 * koffi is loaded lazily and only on Windows: on any other platform, or when the dependency is
 * missing, `tile()` fails with a clear `tiling_unavailable` error instead of silently doing
 * nothing.
 *
 * Windows are matched by the browser pid Playwright reports for the profile. Only *visible*
 * top-level windows are considered, and the largest one wins, so the engine's invisible helper
 * windows are never moved.
 *
 * DPI: the process's awareness decides whether these coordinates are physical or virtualised, and
 * both `GetWindowRect` and the work-area query go through the same process context, so the grid
 * stays consistent either way.
 */

import { SyncError } from './errors.js'
import type { Rect } from './tile-grid.js'

export interface TileBackend {
  /** Work area (screen minus taskbar) of `displayIndex`; `null` means the primary monitor. */
  workArea(displayIndex: number | null): Promise<Rect>
  /** Move the browser window owned by `pid` into `rect`. Returns how many windows were moved. */
  place(pid: number, rect: Rect): Promise<number>
  /** Bring the window owned by `pid` to the front (best effort — Windows may refuse). */
  focus(pid: number): Promise<void>
}

export function createTileBackend(): TileBackend {
  return new WindowsTileBackend()
}

class WindowsTileBackend implements TileBackend {
  async workArea(displayIndex: number | null): Promise<Rect> {
    const api = await loadUser32()
    if (displayIndex === null) {
      return api.primaryWorkArea()
    }
    const monitors = api.monitors()
    const monitor = monitors[displayIndex]
    if (!monitor) {
      throw new SyncError(
        `display ${displayIndex} does not exist (${monitors.length} monitor(s) found)`,
        'tiling_unavailable',
      )
    }
    return monitor.work
  }

  async place(pid: number, rect: Rect): Promise<number> {
    const api = await loadUser32()
    const window = pickWindow(api.windows(), pid)
    if (!window) {
      return 0
    }
    if (window.iconic) {
      api.restore(window.hwnd)
    }
    return api.move(window.hwnd, rect) ? 1 : 0
  }

  async focus(pid: number): Promise<void> {
    const api = await loadUser32()
    const window = pickWindow(api.windows(), pid)
    if (window) {
      api.foreground(window.hwnd)
    }
  }
}

/* ------------------------------------------------------------------- native (user32) surface */

interface NativeRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface NativeMonitorInfo {
  cbSize: number
  rcMonitor: NativeRect
  rcWork: NativeRect
  dwFlags: number
}

interface NativeWindow {
  hwnd: number
  pid: number
  rect: Rect
  visible: boolean
  iconic: boolean
}

interface NativeMonitor {
  work: Rect
  bounds: Rect
  primary: boolean
}

interface User32Api {
  primaryWorkArea(): Rect
  monitors(): NativeMonitor[]
  windows(): NativeWindow[]
  move(hwnd: number, rect: Rect): boolean
  restore(hwnd: number): void
  foreground(hwnd: number): boolean
}

const SPI_GETWORKAREA = 0x0030
const SW_RESTORE = 9
const MONITORINFO_SIZE = 40
const MONITORINFOF_PRIMARY = 0x1

/** koffi's own surface, limited to what this file calls. */
interface KoffiType {
  readonly name?: string
}
type KoffiCallback = (...args: unknown[]) => unknown
type KoffiFunction = (...args: unknown[]) => unknown
interface KoffiLibrary {
  func(signature: string): KoffiFunction
}
interface KoffiModule {
  load(path: string): KoffiLibrary
  struct(name: string, fields: Record<string, string | KoffiType>): KoffiType
  proto(signature: string): KoffiType
  pointer(type: KoffiType): KoffiType
  register(callback: KoffiCallback, type: KoffiType): unknown
  unregister(handle: unknown): void
}

let user32Promise: Promise<User32Api> | null = null

/** Loaded once per process: koffi registers types by name and refuses duplicates. */
function loadUser32(): Promise<User32Api> {
  user32Promise ??= createUser32()
  return user32Promise
}

async function loadKoffi(): Promise<KoffiModule> {
  // A non-literal specifier on purpose: koffi ships prebuilt napi binaries and is only needed on
  // Windows, so a static import would make `tsc` and every non-Windows install depend on it.
  const specifier = 'koffi'
  const loaded = (await import(specifier)) as KoffiModule & { default?: KoffiModule }
  return loaded.default ?? loaded
}

async function createUser32(): Promise<User32Api> {
  if (process.platform !== 'win32') {
    throw new SyncError('window tiling is only implemented for Windows', 'tiling_unavailable')
  }

  let koffi: KoffiModule
  try {
    koffi = await loadKoffi()
  } catch (error) {
    throw new SyncError(
      `window tiling needs the "koffi" dependency (run pnpm install): ${message(error)}`,
      'tiling_unavailable',
    )
  }

  const rectType = koffi.struct('VFOX_RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  })
  // Registered for its side effect: koffi resolves type names globally, so the signature strings
  // below can refer to `VFOX_MONITORINFO` without threading the type object through every call.
  koffi.struct('VFOX_MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: rectType,
    rcWork: rectType,
    dwFlags: 'uint32',
  })
  const enumWindowsProc = koffi.proto(
    'bool __stdcall VFoxEnumWindowsProc(intptr_t hwnd, intptr_t lParam)',
  )
  const monitorEnumProc = koffi.proto(
    'bool __stdcall VFoxMonitorEnumProc(intptr_t hMonitor, intptr_t hdc, intptr_t lprc, intptr_t dwData)',
  )

  const user32 = koffi.load('user32.dll')
  const enumWindows = user32.func(
    'bool __stdcall EnumWindows(VFoxEnumWindowsProc *lpEnumFunc, intptr_t lParam)',
  )
  const enumDisplayMonitors = user32.func(
    'bool __stdcall EnumDisplayMonitors(intptr_t hdc, intptr_t lprc, VFoxMonitorEnumProc *lpfnEnum, intptr_t dwData)',
  )
  const getMonitorInfo = user32.func(
    'bool __stdcall GetMonitorInfoW(intptr_t hMonitor, _Inout_ VFOX_MONITORINFO *lpmi)',
  )
  const getWindowThreadProcessId = user32.func(
    'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)',
  )
  const getWindowRect = user32.func(
    'bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ VFOX_RECT *lpRect)',
  )
  const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
  const isIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)')
  const moveWindow = user32.func(
    'bool __stdcall MoveWindow(intptr_t hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)',
  )
  const showWindow = user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)')
  const setForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
  const systemParametersInfo = user32.func(
    'bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, _Inout_ VFOX_RECT *pvParam, uint32 fWinIni)',
  )

  return {
    primaryWorkArea(): Rect {
      const bounds = emptyRect()
      const ok = systemParametersInfo(SPI_GETWORKAREA, 0, bounds, 0)
      if (!ok) {
        throw new SyncError(
          'SystemParametersInfoW(SPI_GETWORKAREA) failed — cannot read the desktop work area',
          'tiling_unavailable',
        )
      }
      return toRect(bounds)
    },

    monitors(): NativeMonitor[] {
      const monitors: NativeMonitor[] = []
      const callback: KoffiCallback = handle => {
        const info: NativeMonitorInfo = {
          cbSize: MONITORINFO_SIZE,
          rcMonitor: emptyRect(),
          rcWork: emptyRect(),
          dwFlags: 0,
        }
        if (getMonitorInfo(toNumber(handle), info)) {
          monitors.push({
            work: toRect(info.rcWork),
            bounds: toRect(info.rcMonitor),
            primary: (toNumber(info.dwFlags) & MONITORINFOF_PRIMARY) === MONITORINFOF_PRIMARY,
          })
        }
        return true
      }
      runEnumeration(koffi, monitorEnumProc, callback, registered =>
        enumDisplayMonitors(0, 0, registered, 0),
      )
      return monitors
    },

    windows(): NativeWindow[] {
      const windows: NativeWindow[] = []
      const callback: KoffiCallback = handle => {
        const hwnd = toNumber(handle)
        const pidOut = [0]
        getWindowThreadProcessId(hwnd, pidOut)
        const bounds = emptyRect()
        if (!getWindowRect(hwnd, bounds)) {
          return true
        }
        windows.push({
          hwnd,
          pid: toNumber(pidOut[0]),
          rect: toRect(bounds),
          visible: Boolean(isWindowVisible(hwnd)),
          iconic: Boolean(isIconic(hwnd)),
        })
        return true
      }
      runEnumeration(koffi, enumWindowsProc, callback, registered => enumWindows(registered, 0))
      return windows
    },

    move(hwnd: number, rect: Rect): boolean {
      return Boolean(moveWindow(hwnd, rect.x, rect.y, rect.width, rect.height, true))
    },

    restore(hwnd: number): void {
      showWindow(hwnd, SW_RESTORE)
    },

    foreground(hwnd: number): boolean {
      return Boolean(setForegroundWindow(hwnd))
    },
  }
}

/**
 * Run an `Enum*` call with a JS callback, registering it for the duration of the synchronous call
 * only — an unregistered pointer would keep the closure (and this package) alive forever.
 */
function runEnumeration(
  koffi: KoffiModule,
  proc: KoffiType,
  callback: KoffiCallback,
  invoke: (registered: unknown) => unknown,
): void {
  const registered = koffi.register(callback, koffi.pointer(proc))
  try {
    invoke(registered)
  } finally {
    koffi.unregister(registered)
  }
}

function pickWindow(windows: NativeWindow[], pid: number): NativeWindow | null {
  let best: NativeWindow | null = null
  for (const window of windows) {
    if (window.pid !== pid || !window.visible) {
      continue
    }
    if (window.rect.width <= 0 || window.rect.height <= 0) {
      continue
    }
    if (!best || area(window.rect) > area(best.rect)) {
      best = window
    }
  }
  return best
}

function area(rect: Rect): number {
  return rect.width * rect.height
}

function emptyRect(): NativeRect {
  return { left: 0, top: 0, right: 0, bottom: 0 }
}

function toRect(native: NativeRect): Rect {
  const left = toNumber(native.left)
  const top = toNumber(native.top)
  const right = toNumber(native.right)
  const bottom = toNumber(native.bottom)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function toNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
