#!/usr/bin/env node
/**
 * engine-version.mjs — the single source of truth for the pinned Camoufox engine version.
 *
 * The value lives in `packages/shared/src/constants.ts` as `ENGINE_VERSION` and is read out of the
 * TypeScript source here, so a script that runs *before* the workspace is built (the CI fetch step)
 * and the built application can never disagree about which engine they mean. Parsing one constant
 * out of one file is deliberately dull: it needs no build, no network and no dependency, and it
 * cannot drift because there is nothing to drift from.
 *
 * Why the engine is pinned at all is documented next to the constant.
 *
 * Usage:
 *   node scripts/engine-version.mjs          # prints the version
 *   import { ENGINE_VERSION } from './engine-version.mjs'
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const constantsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'constants.ts')

let source
try {
  source = readFileSync(constantsPath, 'utf8')
} catch (error) {
  console.error(`[engine-version] cannot read ${constantsPath}: ${error.message}`)
  process.exit(1)
}

const match = /export const ENGINE_VERSION = '([^']+)'/.exec(source)
if (!match) {
  console.error(
    `[engine-version] no \`export const ENGINE_VERSION = '...'\` in ${constantsPath}.\n` +
      '  The pinned engine version must live there; every other consumer reads it from this script.',
  )
  process.exit(1)
}

export const ENGINE_VERSION = match[1]

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(ENGINE_VERSION)
}
