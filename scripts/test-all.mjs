#!/usr/bin/env node
/**
 * test-all.mjs — run every workspace package's test suite, and report all of them.
 *
 * `pnpm -r run test` stops at the first failing package, so one broken package hides whether
 * any other package's suite even ran. `pnpm -r --no-bail run test` is not the fix: pnpm's own
 * help says it "will exit with a 0 exit code even if" a command fails, which would turn a red
 * suite green — strictly worse than the problem. This runs every suite, names each result,
 * and still fails.
 *
 * The package list is derived from the workspace rather than hardcoded, so a new package
 * cannot be silently skipped.
 *
 * Usage:
 *   node scripts/test-all.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { run } from './run-command.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const packages = []
for (const group of ['packages', 'apps']) {
  const base = path.join(repoRoot, group)
  if (!existsSync(base)) continue
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = path.join(base, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof pkg.scripts?.test === 'string') packages.push(pkg.name)
  }
}

if (packages.length === 0) {
  console.error('[test-all] no workspace package declares a `test` script')
  process.exit(1)
}

console.log(`[test-all] ${packages.length} test suites: ${packages.join(', ')}`)

const failed = []
for (const name of packages) {
  console.log(`\n[test-all] ===== ${name} =====`)
  const status = run('pnpm', ['--filter', name, 'test'], repoRoot)
  if (status === 0) {
    console.log(`[test-all] PASS ${name}`)
  } else {
    console.log(`[test-all] FAIL ${name} (exit ${status})`)
    failed.push(name)
  }
}

console.log('')
if (failed.length > 0) {
  console.error(
    `[test-all] ${failed.length} of ${packages.length} test suites failed: ${failed.join(', ')}`,
  )
  process.exit(1)
}
console.log(`[test-all] all ${packages.length} test suites passed`)
