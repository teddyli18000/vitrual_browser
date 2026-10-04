/**
 * Win32 window/process inspection for the verification scripts.
 *
 * `user32.dll` through koffi — a prebuilt napi FFI, no compiler and no build step — plus the
 * PowerShell/CIM process queries that Windows has no Node API for. Shared by
 * `scripts/verify-window.mjs` (which needs the engine's real window) and `scripts/probe-windows.mjs`
 * (the pre-flight diagnostic that answers "can this machine see windows at all?").
 *
 * koffi is imported through a non-literal specifier and only on Windows: it ships prebuilt binaries
 * and resolves from the hoisted root `node_modules` (the workspace uses pnpm's hoisted node-linker),
 * so nothing here is needed on any other platform.
 *
 * Everything throws plain `Error`s with actionable messages; the caller decides how to report them.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ hwnd: number, pid: number, visible: boolean, iconic: boolean, rect: Rect | null,
 *             title: string }} Win32Window
 * @typedef {{ pid: number, commandLine: string }} EngineProcess
 */

import { spawnSync } from 'node:child_process'

/** A maximized Windows window has an invisible border that can extend past the work area. */
export const WORK_AREA_TOLERANCE = 32

let user32Promise = null

/** Loaded once per process: koffi registers its types globally and refuses duplicate names. */
export function loadUser32() {
  user32Promise ??= createUser32()
  return user32Promise
}

async function createUser32() {
  if (process.platform !== 'win32') {
    throw new Error('window inspection is only implemented for Windows')
  }

  let koffi
  try {
    const specifier = 'koffi'
    const loaded = await import(specifier)
    koffi = loaded.default ?? loaded
  } catch (error) {
    throw new Error(`koffi is required to inspect OS windows: ${message(error)} (run pnpm install)`)
  }

  koffi.struct('VW_RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  })
  const enumProc = koffi.proto('bool __stdcall VWEumProc(intptr_t hwnd, intptr_t lParam)')
  const user32 = koffi.load('user32.dll')

  const enumWindows = user32.func('bool __stdcall EnumWindows(VWEumProc *cb, intptr_t lParam)')
  const getWindowThreadProcessId = user32.func(
    'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)',
  )
  const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
  const isIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)')
  const getWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ VW_RECT *r)')
  const getWindowTextLength = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)')
  const getWindowText = user32.func(
    'int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ char16_t *buf, int maxCount)',
  )
  const showWindow = user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)')
  const setForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
  const systemParametersInfo = user32.func(
    'bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, _Inout_ VW_RECT *rect, uint32 winIni)',
  )

  /** @returns {Rect | null} */
  function rectOf(hwnd) {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    if (!getWindowRect(hwnd, rect)) {
      return null
    }
    return {
      x: Number(rect.left),
      y: Number(rect.top),
      width: Number(rect.right) - Number(rect.left),
      height: Number(rect.bottom) - Number(rect.top),
    }
  }

  function titleOf(hwnd) {
    const length = Number(getWindowTextLength(hwnd))
    if (!Number.isFinite(length) || length <= 0) {
      return ''
    }
    const buffer = koffi.alloc('char16_t', length + 1)
    getWindowText(hwnd, buffer, length + 1)
    return String(koffi.decode(buffer, 'char16_t', -1))
  }

  return {
    /** @returns {Win32Window[]} */
    windows() {
      /** @type {Win32Window[]} */
      const found = []
      const callback = handle => {
        const hwnd = Number(handle)
        const pidOut = [0]
        getWindowThreadProcessId(hwnd, pidOut)
        found.push({
          hwnd,
          pid: Number(pidOut[0]),
          visible: Boolean(isWindowVisible(hwnd)),
          iconic: Boolean(isIconic(hwnd)),
          rect: rectOf(hwnd),
          title: titleOf(hwnd),
        })
        return true
      }
      const registered = koffi.register(callback, koffi.pointer(enumProc))
      try {
        enumWindows(registered, 0)
      } finally {
        koffi.unregister(registered)
      }
      return found
    },

    /** @returns {Rect | null} */
    workArea() {
      const rect = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!systemParametersInfo(0x0030, 0, rect, 0)) {
        return null
      }
      return {
        x: Number(rect.left),
        y: Number(rect.top),
        width: Number(rect.right) - Number(rect.left),
        height: Number(rect.bottom) - Number(rect.top),
      }
    },

    bringToFront(hwnd, iconic) {
      if (iconic) {
        showWindow(hwnd, 9)
      }
      return Boolean(setForegroundWindow(hwnd))
    },
  }
}

/**
 * The largest visible window owned by any pid in `pids` — the engine's real window.
 *
 * @param {Win32Window[]} windows
 * @param {Set<number>} pids
 * @returns {Win32Window | null}
 */
export function pickLargestWindow(windows, pids) {
  let best = null
  let bestArea = 0
  for (const window of windows) {
    if (!pids.has(window.pid) || !window.visible || !window.rect) {
      continue
    }
    const { width, height } = window.rect
    if (width <= 1 || height <= 1) {
      continue
    }
    const area = width * height
    if (area > bestArea) {
      best = window
      bestArea = area
    }
  }
  return best
}

/**
 * The engine's visible window may belong to a child of the process Playwright reports, so the pid
 * set is the launcher plus its descendants. CIM is the only practical way to walk that on Windows;
 * when it is unavailable the result degrades to the launcher pid alone and `walked` says so.
 *
 * @param {number} rootPid
 * @returns {{ pids: Set<number>, walked: boolean, reason: string | null }}
 */
export function enginePids(rootPid) {
  const pids = new Set([rootPid])
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress -AsArray'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !result.stdout) {
    return { pids, walked: false, reason: result.error?.message ?? 'CIM returned nothing' }
  }
  let rows
  try {
    rows = JSON.parse(result.stdout)
  } catch (error) {
    return { pids, walked: false, reason: message(error) }
  }
  if (!Array.isArray(rows)) {
    return { pids, walked: false, reason: 'CIM returned a non-array' }
  }

  /** @type {Map<number, number[]>} */
  const children = new Map()
  for (const row of rows) {
    const parent = Number(row?.ParentProcessId)
    const child = Number(row?.ProcessId)
    if (!Number.isInteger(parent) || !Number.isInteger(child)) {
      continue
    }
    const list = children.get(parent) ?? []
    list.push(child)
    children.set(parent, list)
  }
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!pids.has(child)) {
        pids.add(child)
        queue.push(child)
      }
    }
  }
  return { pids, walked: true, reason: null }
}

/**
 * Every running engine process, or `null` when the platform cannot enumerate them.
 *
 * @returns {EngineProcess[] | null}
 */
export function listEngineProcesses() {
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'camoufox.exe\'"',
    'Select-Object ProcessId,CommandLine',
    'ConvertTo-Json -Compress -AsArray',
  ].join(' | ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !result.stdout) {
    return null
  }
  try {
    const rows = JSON.parse(result.stdout)
    if (!Array.isArray(rows)) {
      return null
    }
    return rows
      .map(row => ({
        pid: Number(row?.ProcessId),
        commandLine: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
      }))
      .filter(entry => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return null
  }
}

export function message(error) {
  return error instanceof Error ? error.message : String(error)
}
