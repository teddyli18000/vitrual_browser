/**
 * Vitest launcher for this package.
 *
 * Two environment problems make a plain `vitest run` impossible on the development machine, and
 * this launcher fixes both without changing what the tests do:
 *
 * 1. Vite bootstraps its Windows path handling by running `net use` through `child_process.exec`,
 *    which needs piped stdio — denied by this machine's file sandbox, so module resolution dies
 *    with `spawn EPERM`. `./sandbox-preload.mjs` answers that one probe locally.
 * 2. Vitest's default `pool: 'forks'` forks a child process over piped stdio for the same reason,
 *    so the scripts pass `--pool=threads`.
 *
 * Loading the vitest CLI in-process (instead of spawning `node_modules/.bin/vitest`) keeps the
 * command identical whether it is started from the repo root or from this directory, and keeps the
 * `NODE_OPTIONS` workaround out of the repository's shared configuration.
 */

import './sandbox-preload.mjs'

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
await import(pathToFileURL(require.resolve('vitest/vitest.mjs')).href)
