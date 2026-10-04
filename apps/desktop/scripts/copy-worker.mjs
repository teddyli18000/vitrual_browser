#!/usr/bin/env node
/**
 * copy-worker.mjs — put the engine-extraction worker where the bundled main process looks for it.
 *
 * `packages/core/src/kernel.ts` starts its extraction worker with:
 *
 *     new Worker(new URL('./unzip-worker.js', import.meta.url), …)
 *
 * That is correct inside `packages/core`, and wrong once electron-vite has bundled the main process:
 * `import.meta.url` becomes the bundle's own path (`out/main/index.cjs`), so the worker is looked for
 * at `out/main/unzip-worker.js` — a file the bundler never emits, because the worker is not an entry
 * point. The packaged app therefore failed every engine install with:
 *
 *     Cannot find module '…\resources\app.asar\out\main\unzip-worker.js'
 *
 * This copies the compiled worker next to the bundle, which is the path the code already asks for.
 * It runs as part of `pnpm --filter @vfox/desktop build`, so a build that forgets it cannot happen.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '..', '..')

const source = path.join(repoRoot, 'packages', 'core', 'dist', 'unzip-worker.js')
const target = path.join(appRoot, 'out', 'main', 'unzip-worker.js')

if (!existsSync(source)) {
  console.error(
    `[copy-worker] ${source} does not exist. Build @vfox/core first — the worker is compiled with it.\n` +
      '  The release workflow and the desktop build script both do this; a bare\n' +
      '  `electron-vite build` in apps/desktop does not.',
  )
  process.exit(1)
}

mkdirSync(path.dirname(target), { recursive: true })
copyFileSync(source, target)

const bytes = statSync(target).size
if (bytes === 0) {
  console.error(`[copy-worker] ${target} is empty`)
  process.exit(1)
}

console.log(`[copy-worker] ${path.relative(repoRoot, target)} (${bytes} bytes)`)
