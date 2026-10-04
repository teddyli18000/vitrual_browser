/**
 * Win32 window/process inspection for the verification scripts.
 *
 * `user32.dll` and `kernel32.dll` through koffi — a prebuilt napi FFI, no compiler and no build step
 * — plus the PowerShell/CIM process queries that Windows has no Node API for. Shared by
 * `scripts/verify-window.mjs` (which needs the engine's real window) and `scripts/probe-windows.mjs`
 * (the pre-flight diagnostic that answers "can this machine see windows at all?").
 *
 * Two ways to decide that a window belongs to the engine, because one of them is not always
 * available:
 *   - by pid (`GetWindowThreadProcessId` against the launcher and its descendants) — exact, but the
 *     process-tree walk needs CIM, and the pid Playwright reports for a *headed* launch is a
 *     launcher stub that owns no window at all (`findEngineWindow` has the details);
 *   - by image name (`EnumWindows` → `GetWindowThreadProcessId` → `OpenProcess` →
 *     `QueryFullProcessImageNameW` → basename) — needs no CIM and no elevated rights.
 *
 * koffi is imported through a non-literal specifier and only on Windows: it ships prebuilt binaries
 * and resolves from the hoisted root `node_modules` (the workspace uses pnpm's hoisted node-linker),
 * so nothing here is needed on any other platform.
 *
 * Everything throws plain `Error`s with actionable messages; the caller decides how to report them.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ hwnd: number, pid: number, visible: boolean, iconic: boolean, rect: Rect | null,
 *             title: string, image: string | null, imagePath: string | null }} Win32Window
 * @typedef {{ pid: number, commandLine: string }} EngineProcess
 * @typedef {{ window: Win32Window | null, matchedBy: 'pid' | 'image-name' | null,
 *             pidWindows: number, imageWindows: number }} EngineWindowLookup
 */

import { spawnSync } from 'node:child_process'

/** A maximized Windows window has an invisible border that can extend past the work area. */
export const WORK_AREA_TOLERANCE = 32

/**
 * The engine's process image name — the same literal as `src/kernel.ts` (`LAUNCH_FILE`) and
 * `src/orphans.ts` (`ENGINE_IMAGE`). These scripts are plain `.mjs` that run without the build, so
 * they cannot import `src`; this third copy is deliberate and greppable.
 */
export const ENGINE_IMAGE_NAME = 'camoufox.exe'

/** `QueryFullProcessImageNameW` wants a character count; 32768 covers every Windows path. */
const MAX_IMAGE_PATH_CHARS = 32_768

/** The weakest access right that still allows `QueryFullProcessImageNameW`. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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
  const kernel32 = koffi.load('kernel32.dll')

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
  const openProcess = kernel32.func(
    'intptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)',
  )
  const queryFullProcessImageName = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32 dwFlags, _Out_ char16_t *lpExeName, _Inout_ uint32 *lpdwSize)',
  )
  const closeHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t hObject)')

  // Reused across calls: the value is decoded immediately after each call, on the same thread, so
  // there is nothing to race with and no reason to allocate 64 KB per window.
  const imageBuffer = koffi.alloc('char16_t', MAX_IMAGE_PATH_CHARS)

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

  /**
   * The image path of `pid` and its lowercase basename, or `null` when Windows will not say.
   *
   * `PROCESS_QUERY_LIMITED_INFORMATION` is the weakest right that still allows
   * `QueryFullProcessImageNameW`, so this works on processes owned by other users and needs no
   * elevation and no CIM/WMI — which is the entire point: CIM is unavailable on some CI runners
   * (`[probe] engine processes: could not enumerate (CIM unavailable)` on GitHub's windows-latest).
   *
   * @returns {{ path: string, name: string } | null}
   */
  function imageOf(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null
    }
    const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!handle) {
      // A protected or already-exited process; the caller only ever needs a yes/no answer.
      return null
    }
    try {
      const size = [MAX_IMAGE_PATH_CHARS]
      if (!queryFullProcessImageName(handle, 0, imageBuffer, size)) {
        return null
      }
      // Decode exactly what was written rather than up to a NUL: the returned length is the
      // contract, and it makes a reused buffer safe even if a path is not terminated.
      const written = Math.min(Number(size[0]) || 0, MAX_IMAGE_PATH_CHARS)
      if (written <= 0) {
        return null
      }
      const path = String(koffi.decode(imageBuffer, 'char16_t', written))
      const base = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
      if (base.length === 0) {
        return null
      }
      return { path, name: base.toLowerCase() }
    } finally {
      closeHandle(handle)
    }
  }

  return {
    /** @returns {Win32Window[]} */
    windows() {
      /** @type {Win32Window[]} */
      const found = []
      // Cached for the duration of ONE enumeration only. A window can appear later for a pid that
      // had none a moment ago — that is precisely the launcher-stub case this lookup exists for — so
      // a cache that outlived the pass would turn a transient miss into a permanent one.
      const images = new Map()
      const imageFor = pid => {
        if (!images.has(pid)) {
          images.set(pid, imageOf(pid))
        }
        return images.get(pid)
      }
      const callback = handle => {
        const hwnd = Number(handle)
        const pidOut = [0]
        getWindowThreadProcessId(hwnd, pidOut)
        const pid = Number(pidOut[0])
        const image = imageFor(pid)
        found.push({
          hwnd,
          pid,
          visible: Boolean(isWindowVisible(hwnd)),
          iconic: Boolean(isIconic(hwnd)),
          rect: rectOf(hwnd),
          title: titleOf(hwnd),
          image: image?.name ?? null,
          imagePath: image?.path ?? null,
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

    /** The image path and lowercase basename of one pid, or `null`. */
    imageOf,

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

/** @param {Win32Window} window */
function areaOf(window) {
  return window.rect ? window.rect.width * window.rect.height : 0
}

/**
 * The largest visible window bigger than 1x1 that `matches`, or `null`.
 *
 * @param {Win32Window[]} windows
 * @param {(window: Win32Window) => boolean} matches
 * @returns {Win32Window | null}
 */
function largestWindow(windows, matches) {
  let best = null
  let bestArea = 0
  for (const window of windows) {
    if (!matches(window) || !window.visible || !window.rect) {
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
 * The largest visible window owned by any pid in `pids` — the engine's real window, when the pid is
 * the right one to ask about.
 *
 * @param {Win32Window[]} windows
 * @param {Set<number>} pids
 * @returns {Win32Window | null}
 */
export function pickLargestWindow(windows, pids) {
  return largestWindow(windows, window => pids.has(window.pid))
}

/**
 * The largest visible window whose process image basename is `imageName` (case-insensitive).
 *
 * Both sides are normalised even though `windows()` already stores a lowercase basename: a silent
 * mismatch here costs a 30-second CI round trip, and the comparison is not the place to be strict
 * about an invariant that lives in another function.
 *
 * @param {Win32Window[]} windows
 * @param {string} imageName
 * @returns {Win32Window | null}
 */
export function pickLargestWindowByImage(windows, imageName) {
  const wanted = String(imageName).toLowerCase()
  return largestWindow(windows, window => matchesImage(window, wanted))
}

/** @param {Win32Window} window @param {string} wanted A lowercase image name. */
function matchesImage(window, wanted) {
  return typeof window.image === 'string' && window.image.toLowerCase() === wanted
}

/**
 * The engine's visible window: by pid first, by process image name as the fallback.
 *
 * Both paths are load-bearing, and for a measured reason rather than a defensive one:
 *
 *   - Playwright passes `-wait-for-browser` when it launches Firefox headed
 *     (`playwright-core/lib/coreBundle.js:44199`), which on Windows makes the spawned process a
 *     **launcher stub**: it hands the browser to a child and waits for it, so the window belongs to
 *     the child rather than to the pid Playwright reports. That is exactly the CI failure this
 *     fallback was written for — the reported pid owned **zero** top-level windows (not even the
 *     hidden helper windows the engine creates within seconds of starting: measured locally, a bare
 *     `camoufox.exe -no-remote -foreground -profile … about:blank` owns three of them) while the
 *     browser was up and Juggler had connected:
 *       VFOX_WINDOW_FAIL {"stage":"unexpected","reason":"no visible top-level window appeared within
 *       30000ms for pid(s) 7544 (0 window(s) belong to those pids ...)"}
 *   - The child is normally reachable by walking the process tree from the reported pid, but that
 *     walk needs CIM and CIM is unavailable on GitHub's windows-latest runner (`[probe] engine
 *     processes: could not enumerate (CIM unavailable)`), so the tree degrades to the launcher pid
 *     alone and the walk finds nothing either.
 *
 * The pid path still wins whenever it found the larger window, so an unrelated or stale engine
 * process can never outrank the one Playwright actually started; the image scan only takes over when
 * it found a strictly larger window, which is the launcher-stub case.
 *
 * @param {Win32Window[]} windows
 * @param {{ pids: Set<number>, imageName: string }} options
 * @returns {EngineWindowLookup}
 */
export function findEngineWindow(windows, { pids, imageName }) {
  const wanted = String(imageName).toLowerCase()
  const byPid = pickLargestWindow(windows, pids)
  const byImage = pickLargestWindowByImage(windows, imageName)
  const useImage = byImage !== null && (byPid === null || areaOf(byImage) > areaOf(byPid))
  const window = useImage ? byImage : byPid
  return {
    window,
    matchedBy: window === null ? null : useImage ? 'image-name' : 'pid',
    // Counted for the failure payload: "0 windows matched" is only diagnosable next to "the pid path
    // looked at these pids and the image path looked at this image name".
    pidWindows: windows.filter(candidate => pids.has(candidate.pid)).length,
    imageWindows: windows.filter(candidate => matchesImage(candidate, wanted)).length,
  }
}

/**
 * A one-line picture of the desktop, largest visible window first — the difference between "no
 * window appeared" and "here is what the desktop actually looked like". It goes into the failure
 * payload so the next run is diagnosable from its own log.
 *
 * @param {Win32Window[]} windows
 * @param {number} limit
 */
export function describeWindows(windows, limit = 8) {
  const visible = windows
    .filter(
      window => window.visible && window.rect && window.rect.width > 1 && window.rect.height > 1,
    )
    .sort((left, right) => areaOf(right) - areaOf(left))
  const described = visible.slice(0, limit).map(window => {
    const label = window.image ?? `pid ${window.pid} (image unknown)`
    const title = window.title.length > 40 ? `${window.title.slice(0, 40)}…` : window.title
    const { width, height, x, y } = window.rect
    return `${label} ${width}x${height} at ${x},${y} "${title}"`
  })
  const total = `${visible.length} visible window(s)`
  return described.length === 0 ? total : `${total}: ${described.join('; ')}`
}

/**
 * The engine's pid plus its descendants.
 *
 * This is an *enhancement* to `findEngineWindow`, not a requirement: the image-name scan works
 * without it, which matters because CIM is the only practical way to walk the tree on Windows and it
 * is unavailable on some runners. `walked: false` means the result is the launcher pid alone.
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
