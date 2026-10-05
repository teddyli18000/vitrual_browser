/**
 * Sandbox preload — required on this development machine, a no-op everywhere else.
 *
 * Vite's Windows path handling bootstraps `safeRealpathSync` by running `net use` through
 * `child_process.exec` (`vite/dist/node/chunks/config.js`). `exec` captures output over a pipe, and
 * this machine's file sandbox denies named pipes, so the spawn throws `EPERM` synchronously and
 * takes Vite's module resolution down with it — every test file fails to load before it runs.
 *
 * The `net use` probe only exists to detect mapped network drives. Answering it locally (as on any
 * machine without a mapped drive) leaves Vite on `fs.realpathSync.native`, which is the correct
 * behaviour here. Every other `exec` call is handed straight through to the real implementation.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

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
