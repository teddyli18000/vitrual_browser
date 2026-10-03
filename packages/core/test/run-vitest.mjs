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
 *   - in CI or any unconfined shell the sandbox probe fails, `./sandbox-preload.mjs` changes
 *     nothing, and Vitest runs with its default `forks` pool — a real process per file, fully
 *     isolated, which is the configuration this suite is meant to run under;
 *   - inside the sandbox the probe succeeds, the preload answers Vite's `net use` bootstrap and
 *     redirects the native `impit` addon to a stub, and the pool becomes `threads` (a `fork()` over
 *     piped stdio is denied here). `--no-isolate` keeps all files in one worker.
 *
 * Loading the vitest CLI in-process keeps the command identical from the repo root or this
 * directory, and keeps the `NODE_OPTIONS` workaround out of the repository's shared configuration.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sandboxed } from './sandbox-preload.mjs'

if (sandboxed) {
  if (!process.argv.includes('--pool=threads')) {
    process.argv.push('--pool=threads', '--no-isolate')
  }
  // The test files run in worker threads, which do not execute this file — they need the preload
  // (and therefore the `impit` stub hook) too, and `NODE_OPTIONS` is inherited by workers.
  const preload = pathToFileURL(new URL('./sandbox-preload.mjs', import.meta.url).pathname).href
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${preload}`]
    .filter(Boolean)
    .join(' ')
}

const require = createRequire(import.meta.url)
await import(pathToFileURL(require.resolve('vitest/vitest.mjs')).href)
