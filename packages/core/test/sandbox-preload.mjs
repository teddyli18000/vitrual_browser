/**
 * Sandbox preload — required on this development machine, a no-op everywhere else.
 *
 * Three environment problems are worked around here, all of them measured on this machine and all
 * of them absent in CI:
 *
 * 1. Vite bootstraps its Windows path handling by running `net use` through `child_process.exec`
 *    (`vite/dist/node/chunks/config.js`). `exec` captures output over a pipe, and the file sandbox
 *    denies named pipes, so the spawn throws `EPERM` synchronously and takes Vite's module
 *    resolution down with it — every test file fails to load before it runs. The probe only exists
 *    to detect mapped network drives, so answering it locally (as on any machine without one) is
 *    correct; every other `exec` call is handed straight through.
 * 2. `impit`, the native HTTP addon camoufox-js loads through `dist/ip.js`, cannot survive a Vitest
 *    worker thread being torn down: importing it alone crashed the process with `0xC0000005` in 4
 *    of 6 measured runs. `./impit-hooks.mjs` redirects it to a loud stub.
 * 3. Vitest's default `pool: 'forks'` forks a child process over piped stdio for the same reason as
 *    (1), so `run-vitest.mjs` switches to the threads pool when it detects the sandbox.
 */

import { createRequire, register } from 'node:module'

// Everything below goes through `createRequire` on purpose: a static `import ... from
// 'node:child_process'` would create the ESM facade for that builtin *before* the patch below, and
// Vite's own `import { exec }` would then snapshot the original function.
const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

/** True when a child process with piped stdio cannot be created — i.e. we are inside the sandbox. */
export const sandboxed = (() => {
  try {
    const probe = childProcess.spawnSync(process.execPath, ['-e', ''], { stdio: 'pipe' })
    return probe.error !== undefined
  } catch {
    return true
  }
})()

if (sandboxed) {
  // Hooks run on their own thread; workers inherit NODE_OPTIONS, so every worker gets this too.
  register('./impit-hooks.mjs', import.meta.url)
}

const realExec = childProcess.exec
const NET_USE = /^net\s+use\s*$/i

childProcess.exec = function sandboxExec(...args) {
  const [command, options, callback] = args
  const cb = typeof options === 'function' ? options : callback
  if (typeof command === 'string' && NET_USE.test(command.trim()) && typeof cb === 'function') {
    queueMicrotask(() => cb(null, '', ''))
    return undefined
  }
  return realExec.apply(this, args)
}
