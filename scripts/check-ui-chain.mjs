#!/usr/bin/env node
/**
 * check-ui-chain.mjs — run the desktop UI guard **CHAIN**, not a single script.
 *
 * WHY THIS FILE EXISTS
 *
 * `ci.yml` used to invoke `apps/desktop/scripts/check-ui-registration.mjs` directly, and that was the
 * only UI guard CI ever ran. `apps/desktop/package.json` defines a `check:ui` chain that also runs
 * `check-ui.mjs` (the silent-blank-UI classes, including the table-column guard that caught a real
 * empty-cell bug) and `check-fingerprint-fields.mjs` (the only coverage of the GUI half of the
 * `humanize` default). A `git grep` over `.github` for those names returned nothing, so both guards
 * ran for nobody but a human — the same failure mode as a structural check that scans zero modules
 * and passes everything.
 *
 * THE CHAIN IS THE SOURCE OF TRUTH, AND THIS SCRIPT DOES NOT DUPLICATE IT
 *
 * It reads `check:ui` out of `apps/desktop/package.json` and runs it through pnpm. So when someone
 * adds a script to that chain, CI starts enforcing it with no workflow change — and when someone
 * removes one, the removal is visible in the diff of the file that owns the definition rather than
 * hidden here. Naming the individual scripts in this file would recreate the original bug.
 *
 * Usage: node scripts/check-ui-chain.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { run } from './run-command.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const packagePath = path.join(repoRoot, 'apps', 'desktop', 'package.json')

let chain
try {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  chain = manifest.scripts?.['check:ui']
} catch (error) {
  console.error(`[check-ui-chain] could not read ${packagePath}: ${error.message}`)
  process.exit(1)
}

if (!chain) {
  console.error(
    '[check-ui-chain] apps/desktop has no "check:ui" script. The UI guards cannot be verified, so ' +
      'this step must not pass.',
  )
  process.exit(1)
}

// Printed so the CI log shows exactly what was enforced, rather than requiring a reader to go and
// find the chain definition.
console.log(`[check-ui-chain] apps/desktop "check:ui" resolves to:\n  ${chain}`)

const code = run('pnpm', ['--filter', '@vfox/desktop', 'check:ui'], repoRoot)
console.log(`[check-ui-chain] the chain exited ${code}`)
process.exit(code)
