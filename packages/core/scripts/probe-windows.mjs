/**
 * Pre-flight diagnostic for the headed window check.
 *
 * Answers the question that decides whether `verify-window.mjs` can pass at all on this machine:
 * *can it see windows, and does it have an interactive desktop?* Run it before the browser starts
 * and the answer is unambiguous — an empty list here means the failure is the environment, not the
 * product. It is also the local way to exercise the `user32.dll`/`kernel32.dll` layer without a
 * browser, which is impossible in the development sandbox.
 *
 * It exercises BOTH window-lookup paths `verify-window.mjs` uses, because only one of them needs
 * CIM:
 *   - the pid path (`enginePids`) walks the process tree through CIM, which is unavailable on
 *     GitHub's windows-latest runner — the "process-tree walk" line below is that path's verdict;
 *   - the image-name path (`EnumWindows` → `GetWindowThreadProcessId` → `OpenProcess` →
 *     `QueryFullProcessImageNameW`) needs no CIM and no elevation, and every window printed below
 *     carries the image name of its process, so a working scan is visible in the output.
 *
 * Run it *while* a browser is open (`--image camoufox.exe`, the default) and the scan line answers
 * "is the engine's window findable by image name?" directly. In CI it runs before any browser, so it
 * can only prove the FFI path works there; the same scan against the live browser is reported by
 * `verify-window.mjs` (the `window-lookup` step, and the desktop snapshot in its failure payload).
 *
 * Usage:
 *   node packages/core/scripts/probe-windows.mjs [--limit 15] [--image camoufox.exe]
 *
 * Exit codes: 0 whenever the FFI layer itself worked (even with zero windows); 2 when it could not
 * be loaded, or when an argument is unusable, which is an environment problem worth reporting loudly.
 */

import {
  ENGINE_IMAGE_NAME,
  enginePids,
  findEngineWindow,
  listEngineProcesses,
  loadUser32,
  message,
} from './lib/user32.mjs'

const argv = process.argv.slice(2)
let limit = 15
let imageName = ENGINE_IMAGE_NAME
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--limit') {
    limit = Number(argv[index + 1] ?? '')
    index += 1
    if (!Number.isInteger(limit) || limit <= 0) {
      process.stderr.write('[probe] --limit needs a positive integer\n')
      process.exit(2)
    }
  } else if (argument === '--image') {
    imageName = String(argv[index + 1] ?? '')
    index += 1
    if (imageName.length === 0) {
      process.stderr.write('[probe] --image needs a process image name, e.g. camoufox.exe\n')
      process.exit(2)
    }
  }
}

let api
try {
  api = await loadUser32()
} catch (error) {
  process.stderr.write(`[probe] cannot load user32/kernel32 through koffi: ${message(error)}\n`)
  process.exit(2)
}

const workArea = api.workArea()
process.stdout.write(`[probe] work area: ${workArea ? JSON.stringify(workArea) : 'unavailable'}\n`)

const windows = api.windows()
const visible = windows.filter(window => window.visible && window.rect)
process.stdout.write(
  `[probe] ${windows.length} top-level window(s), ${visible.length} visible with a rect\n`,
)

const ranked = visible
  .slice()
  .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)
  .slice(0, limit)

for (const window of ranked) {
  const { width, height } = window.rect
  process.stdout.write(
    `[probe] pid ${window.pid} hwnd ${window.hwnd} ${width}x${height} ` +
      `at ${window.rect.x},${window.rect.y} "${window.title}" ` +
      `[${window.image ?? 'image name unavailable'}]\n`,
  )
}

// The image-name scan is only as trustworthy as its coverage: a name that could not be resolved for
// a window means `OpenProcess`/`QueryFullProcessImageNameW` was refused for that process, and such a
// window can never match. Say so instead of letting it look like "not the engine".
const resolved = visible.filter(window => window.image !== null)
const counts = new Map()
for (const window of resolved) {
  counts.set(window.image, (counts.get(window.image) ?? 0) + 1)
}
const histogram = [...counts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .slice(0, 6)
  .map(([name, count]) => `${name} x${count}`)
  .join(', ')
process.stdout.write(
  `[probe] image names: ${resolved.length}/${visible.length} visible window(s) resolved` +
    `${visible.length - resolved.length > 0 ? ` (${visible.length - resolved.length} refused by Windows)` : ''}` +
    `${histogram.length > 0 ? `; seen: ${histogram}` : ''}\n`,
)

const scan = findEngineWindow(windows, { pids: new Set(), imageName })
process.stdout.write(
  `[probe] image-name scan for "${imageName}": ${scan.imageWindows} window(s)` +
    (scan.window
      ? `; largest is pid ${scan.window.pid} hwnd ${scan.window.hwnd} ` +
        `${scan.window.rect.width}x${scan.window.rect.height} at ${scan.window.rect.x},${scan.window.rect.y} ` +
        `"${scan.window.title}"\n`
      : '; nothing on this desktop belongs to that image\n'),
)

const engines = listEngineProcesses()
process.stdout.write(
  `[probe] engine processes: ${engines === null ? 'could not enumerate (CIM unavailable)' : engines.length}\n`,
)

// Walking the tree from our own pid is the same call the window check makes for the engine.
const tree = enginePids(process.pid)
process.stdout.write(
  `[probe] process-tree walk from pid ${process.pid}: ` +
    `${tree.walked ? `${tree.pids.size} pid(s)` : `unavailable (${tree.reason})`}\n`,
)

process.stdout.write(
  `[probe] ${visible.length === 0 ? 'NO VISIBLE WINDOWS — this session has no interactive desktop' : 'windows are visible; a headed browser check can run here'}\n`,
)
process.exit(0)
