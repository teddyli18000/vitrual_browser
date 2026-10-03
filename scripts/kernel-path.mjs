#!/usr/bin/env node
/**
 * kernel-path.mjs — print the resolved Camoufox engine directory.
 *
 * Resolution is delegated to `camoufox-js` itself (`INSTALL_DIR`, `installedVerStr()`,
 * `launchPath()`) instead of being re-derived here, so this script can never drift from
 * the directory the engine is actually installed into and launched from.
 *
 * Contract:
 *   stdout — exactly one line: the engine directory (or the JSON object with --json).
 *   stderr — human diagnostics.
 *   exit 0 when the engine is installed, exit 1 with a clear reason when it is not.
 *
 * Usage:
 *   node scripts/kernel-path.mjs
 *   node scripts/kernel-path.mjs --json
 */
import { existsSync, readdirSync } from 'node:fs'
import process from 'node:process'

const asJson = process.argv.includes('--json')

/** @param {string} message */
function fail(message) {
  console.error(`[kernel-path] ${message}`)
  process.exit(1)
}

/** camoufox-js owns the install-dir rules; import them rather than duplicating them. */
async function loadPkgman() {
  try {
    return await import('camoufox-js/dist/pkgman.js')
  } catch (error) {
    return fail(
      `cannot load camoufox-js (${error.message}).\n` +
        'Run `pnpm install` first — the engine location is defined by that package.',
    )
  }
}

const pkgman = await loadPkgman()
const dir = pkgman.INSTALL_DIR

if (!existsSync(dir) || readdirSync(dir).length === 0) {
  fail(
    `the Camoufox engine is not installed.\n` +
      `  expected at: ${dir}\n` +
      '  fix: run `pnpm kernel:fetch` (or `node scripts/fetch-kernel.mjs`).',
  )
}

let version
try {
  version = pkgman.installedVerStr()
} catch (error) {
  fail(
    `the Camoufox engine at ${dir} is incomplete: ${error.message}\n` +
      '  fix: run `pnpm kernel:fetch` to (re)install it.',
  )
}

let launcher
try {
  launcher = pkgman.launchPath()
} catch (error) {
  fail(
    `the Camoufox engine at ${dir} reports version ${version} but its launcher is missing: ` +
      `${error.message}\n  fix: run \`pnpm kernel:fetch\` to reinstall it.`,
  )
}

if (asJson) {
  console.log(
    JSON.stringify({
      dir,
      version,
      launcher,
      source: process.env.CAMOUFOX_INSTALL_DIR ? 'CAMOUFOX_INSTALL_DIR' : 'camoufox-js default',
    }),
  )
} else {
  console.error(`[kernel-path] camoufox ${version} -> ${launcher}`)
  console.log(dir)
}
