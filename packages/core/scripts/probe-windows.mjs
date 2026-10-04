/**
 * Pre-flight diagnostic for the headed window check.
 *
 * Answers the question that decides whether `verify-window.mjs` can pass at all on this machine:
 * *can it see windows, and does it have an interactive desktop?* Run it before the browser starts
 * and the answer is unambiguous — an empty list here means the failure is the environment, not the
 * product. It is also the local way to exercise the `user32.dll` layer without a browser, which is
 * impossible in the development sandbox.
 *
 * Usage:
 *   node packages/core/scripts/probe-windows.mjs [--limit 15]
 *
 * Exit codes: 0 whenever the FFI layer itself worked (even with zero windows); 2 when it could not
 * be loaded, which is an environment problem worth reporting loudly.
 */

import { enginePids, listEngineProcesses, loadUser32, message } from './lib/user32.mjs'

const argv = process.argv.slice(2)
let limit = 15
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--limit') {
    limit = Number(argv[index + 1] ?? 15)
    index += 1
  }
}

let api
try {
  api = await loadUser32()
} catch (error) {
  process.stderr.write(`[probe] cannot load user32 through koffi: ${message(error)}\n`)
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
      `at ${window.rect.x},${window.rect.y} "${window.title}"\n`,
  )
}

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
