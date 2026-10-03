/**
 * Vitest launcher for this package.
 *
 * The suite is strict TypeScript that imports `src/`, which Vitest cannot run directly on this
 * machine: Vite transpiles `.ts` with esbuild, and esbuild's service needs a piped child process
 * that the file sandbox denies with `EPERM`. The npm script therefore compiles the tests (and
 * `src`) with `tsc` into `.test-build/` first and this launcher runs the *compiled* files, which
 * need no transpilation at all.
 *
 * The pool is chosen by probing the environment rather than by assuming one:
 *
 *   - in CI or any unconfined shell the probe finds that piped child stdio works, and Vitest runs
 *     with its default `forks` pool — a real process per file, fully isolated. **That is the
 *     authoritative configuration** and the one this suite is meant to run under;
 *   - inside the sandbox the probe fails, `./sandbox-preload.mjs` answers Vite's `net use`
 *     bootstrap, and the pool becomes `threads` (`--no-isolate` keeps all files in one worker),
 *     because a `fork()` over piped stdio is denied here.
 *
 * The sandboxed configuration is best-effort, not authoritative, and the reason is measured rather
 * than assumed: `camoufox-js/dist/utils.js` imports `./ip.js`, which does
 * `import { Impit } from 'impit'` — a native napi addon — at module load and keeps constructed
 * clients in a module-level Map. Importing `impit` and doing nothing else crashed a Vitest worker
 * thread at teardown with `0xC0000005` in 4 of 6 measured runs. Anything that calls `launchOptions`
 * (so `test/launcher.guard.test.ts`) therefore passes all of its assertions and then *may* kill the
 * process while the worker is being torn down. CI is unaffected: a forked process has no worker
 * thread to tear down.
 *
 * Loading the vitest CLI in-process keeps the command identical from the repo root or this
 * directory, and keeps the `NODE_OPTIONS` workaround out of the repository's shared configuration.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sandboxed } from './sandbox-preload.mjs'

if (sandboxed && !process.argv.includes('--pool=threads')) {
  process.argv.push('--pool=threads', '--no-isolate')
}

const require = createRequire(import.meta.url)
await import(pathToFileURL(require.resolve('vitest/vitest.mjs')).href)
