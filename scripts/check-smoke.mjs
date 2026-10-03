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

// The script drops `webgl` from `compared` when neither profile reported a vendor, so the
// denominator is 7 or 8 depending on the evidence. Asserting it cannot fall below the
// requirement stops a silently shrinking comparison from passing on a technicality.
const compared = Array.isArray(result.compared) ? result.compared : undefined
if (compared && compared.length < requiredDistinct) {
  fail(
    `only ${compared.length} fingerprint dimensions were compared, but ${requiredDistinct} ` +
      `distinct ones are required: ${JSON.stringify(compared)}`,
  )
}

if (distinctCount < requiredDistinct) {
  fail(
    `only ${distinctCount} of ${compared?.length ?? '?'} fingerprint dimensions differ between ` +
      `the two profiles; ${requiredDistinct} are required. Distinct: ${JSON.stringify(result.distinct ?? [])}`,
  )
}

// Stable identity across relaunches is the strongest claim in the job. The script already
// fails on it; re-checking here means weakening that check cannot silently ship.
for (const entry of result.stability ?? []) {
  if (entry?.identical !== true) {
    fail(
      `profile ${entry?.profileId} changed between launches: ${JSON.stringify(entry?.differing ?? entry)}`,
    )
  }
}

const engine = stdout.match(/^VFOX_SMOKE_ENGINE (.*)$/m)
if (engine) console.log(`[check-smoke] engine: ${engine[1]}`)
// Evidence lines. The stream split is frozen: stdout carries only these markers, stderr the rest.
for (const marker of ['VFOX_SMOKE_PROFILE', 'VFOX_SMOKE_RELAUNCH']) {
  for (const line of stdout.match(new RegExp(`^${marker} .*$`, 'gm')) ?? []) {
    console.log(`[check-smoke] ${line}`)
  }
}
// Warnings never fail the run, but they are how a dimension quietly drops out of the
// comparison (for example WebGL with no vendor evidence) — surface them in the CI log.
for (const line of stderr.match(/^VFOX_SMOKE_WARN .*$/gm) ?? []) {
  console.log(`[check-smoke] ${line}`)
}

console.log(
  `[check-smoke] OK: ${distinctCount}/${compared?.length ?? 8} fingerprint dimensions differ ` +
    `(required ${requiredDistinct}); profiles: ${Array.isArray(result.profiles) ? result.profiles.length : '?'}` +
    (result.stability?.length ? `; relaunch stability: identical` : ''),
)
