#!/usr/bin/env node
/**
 * check-smoke.mjs — the CI gate for `packages/core/scripts/smoke-launch.mjs`.
 *
 * The smoke script is the only place where the product's core claim ("the Camoufox engine
 * really launches and really spoofs") is executed, so its result is checked here instead of
 * being eyeballed in the log. The contract below is frozen by the owner of that script:
 *
 *   exit 0  -> stdout contains exactly one line `VFOX_SMOKE_OK {json}` and the JSON reports
 *              `distinctCount >= requiredDistinct`
 *   exit 1  -> fingerprint/assertion failure
 *   exit 2  -> the engine could not be launched at all
 *   stderr  -> on failure, one line `VFOX_SMOKE_FAIL {stage, reason, hint}`
 *
 * On any failure the full captured stdout and stderr are reprinted, because the CI log is
 * where the engine gets debugged.
 *
 * Usage:
 *   node scripts/check-smoke.mjs --stdout <file> --stderr <file> --exit-code <n>
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'

const OK_MARKER = /^VFOX_SMOKE_OK (.*)$/m
const FAIL_MARKER = /^VFOX_SMOKE_FAIL (.*)$/m

/** @param {string} name */
function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function readIfPresent(file) {
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    return `<could not read ${file}: ${error.message}>`
  }
}

const stdoutFile = arg('stdout')
const stderrFile = arg('stderr')
const exitCode = Number(arg('exit-code') ?? '0')

if (!stdoutFile) {
  console.error('[check-smoke] --stdout <file> is required')
  process.exit(2)
}

const stdout = readIfPresent(stdoutFile)
const stderr = readIfPresent(stderrFile)

console.log('===== smoke-launch stdout =====')
console.log(stdout.trimEnd() || '<empty>')
console.log('===== smoke-launch stderr =====')
console.log(stderr.trimEnd() || '<empty>')
console.log('===============================')

/** `stage` values the smoke script reports, with the action that fixes each one. */
const STAGE_HINTS = {
  'build-missing': 'run `pnpm --filter @vfox/core build` before this script',
  'engine-missing': 'run `pnpm kernel:fetch` (or `node scripts/fetch-kernel.mjs`) first',
  launch:
    'the engine could not be spawned; on a runner this means the engine or its dlls are incomplete',
  fingerprint: 'the engine launched but did not spoof distinct fingerprints',
  orphan: 'browser processes survived the run; `core.close()` did not kill the whole tree',
  unexpected: 'the smoke script itself threw',
}

/** @param {string} message */
function fail(message) {
  console.error(`[check-smoke] FAIL: ${message}`)
  const reported = (stderr.match(FAIL_MARKER) ?? stdout.match(FAIL_MARKER))?.[1]
  if (reported) {
    console.error(`[check-smoke] smoke script reported: ${reported}`)
    try {
      const stage = JSON.parse(reported).stage
      if (STAGE_HINTS[stage]) console.error(`[check-smoke] stage "${stage}": ${STAGE_HINTS[stage]}`)
    } catch {
      // A malformed failure payload is already reported verbatim above.
    }
  }
  if (exitCode === 2) {
    console.error('[check-smoke] exit code 2 = the engine could not be launched at all.')
  }
  process.exit(1)
}

if (exitCode !== 0) {
  fail(`smoke-launch.mjs exited with code ${exitCode} (expected 0).`)
}

const match = stdout.match(OK_MARKER)
if (!match) {
  fail('no `VFOX_SMOKE_OK {json}` line on stdout — the engine integration was not verified.')
}

let result
try {
  result = JSON.parse(match[1])
} catch (error) {
  fail(`the VFOX_SMOKE_OK payload is not valid JSON: ${error.message}`)
}

const distinctCount = result.distinctCount
const requiredDistinct = result.requiredDistinct
if (typeof distinctCount !== 'number' || typeof requiredDistinct !== 'number') {
  fail(
    'the VFOX_SMOKE_OK payload is missing numeric `distinctCount` / `requiredDistinct` ' +
      `(got ${JSON.stringify(result)}).`,
  )
}
if (distinctCount < requiredDistinct) {
  fail(
    `only ${distinctCount} of the 8 fingerprint dimensions differ between the two profiles; ` +
      `${requiredDistinct} are required. Distinct: ${JSON.stringify(result.distinct ?? [])}`,
  )
}

const engine = stdout.match(/^VFOX_SMOKE_ENGINE (.*)$/m)
if (engine) console.log(`[check-smoke] engine: ${engine[1]}`)
// Per-profile evidence lines. The stream split is frozen: stdout carries only these markers.
for (const profile of stdout.match(/^VFOX_SMOKE_PROFILE .*$/gm) ?? []) {
  console.log(`[check-smoke] ${profile}`)
}
console.log(
  `[check-smoke] OK: ${distinctCount}/8 fingerprint dimensions differ ` +
    `(required ${requiredDistinct}); profiles: ${Array.isArray(result.profiles) ? result.profiles.length : '?'}`,
)
