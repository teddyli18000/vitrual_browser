#!/usr/bin/env node
/**
 * fetch-kernel.mjs — download (or verify) the Camoufox engine used by VFox.
 *
 * This is the wrapper CI uses instead of a bare `camoufox-js fetch`, because it:
 *   1. pins `CAMOUFOX_INSTALL_DIR` into the repo-local `.cache/camoufox` when the caller
 *      did not set it, so `actions/cache` and `scripts/kernel-path.mjs` agree on one path;
 *   2. retries the whole fetch once (camoufox-js already retries each HTTP request 5x, but
 *      a dropped connection mid-download still aborts the run);
 *   3. re-reads `version.json` afterwards and prints the resolved engine version, and
 *      fails loudly if the engine is not actually launchable.
 *
 * `stdio: 'inherit'` is deliberate: it keeps camoufox-js's progress bar live in the CI log
 * and avoids named pipes, which this project's local sandbox denies to child processes.
 *
 * Usage:
 *   node scripts/fetch-kernel.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Same default as scripts/dev-env.ps1: keep the ~550 MB engine inside the checkout, which
// is the only location this project's local sandbox and actions/cache can both reach.
const defaultDir = path.join(repoRoot, '.cache', 'camoufox')
const installDir = path.resolve(process.env.CAMOUFOX_INSTALL_DIR ?? defaultDir)
process.env.CAMOUFOX_INSTALL_DIR = installDir
mkdirSync(installDir, { recursive: true })

console.error(
  `[fetch-kernel] install dir: ${installDir}` +
    (process.env.CAMOUFOX_INSTALL_DIR === defaultDir ? ' (repo-local default)' : ''),
)

const require = createRequire(import.meta.url)
let cli
try {
  cli = require.resolve('camoufox-js/dist/__main__.js')
} catch (error) {
  console.error(
    `[fetch-kernel] cannot resolve camoufox-js (${error.message}). Run \`pnpm install\` first.`,
  )
  process.exit(1)
}

/** @returns {Promise<number>} the child's exit code (never throws for a non-zero exit). */
function runFetch() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'fetch'], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    })
    child.on('error', error => {
      console.error(`[fetch-kernel] failed to start camoufox-js: ${error.message}`)
      resolve(1)
    })
    child.on('close', code => resolve(code ?? 1))
  })
}

let code = await runFetch()
if (code !== 0) {
  console.error(`[fetch-kernel] fetch failed (exit ${code}); retrying once in 15s...`)
  await delay(15_000)
  code = await runFetch()
}
if (code !== 0) {
  console.error(
    `[fetch-kernel] the Camoufox engine could not be fetched after 2 attempts (exit ${code}).`,
  )
  process.exit(code)
}

const versionFile = path.join(installDir, 'version.json')
if (!existsSync(versionFile)) {
  console.error(
    `[fetch-kernel] camoufox-js reported success but ${versionFile} is missing — ` +
      'the engine is not installed.',
  )
  process.exit(1)
}

const { version, release } = JSON.parse(readFileSync(versionFile, 'utf8'))
const resolved = `${version}-${release}`

const launcherName = process.platform === 'win32' ? 'camoufox.exe' : 'camoufox-bin'
if (!existsSync(path.join(installDir, launcherName))) {
  console.error(`[fetch-kernel] ${launcherName} is missing from ${installDir}.`)
  process.exit(1)
}

console.error(`[fetch-kernel] camoufox ${resolved} installed at ${installDir}`)
