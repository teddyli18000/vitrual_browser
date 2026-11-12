#!/usr/bin/env node
/**
 * check-launch-fetches.mjs — assert how many OUTBOUND REQUESTS a launch makes, and PRINT the number.
 *
 * WHY THIS EXISTS. The product rule allows exactly three outbound calls: the engine download on first
 * run, the user's own proxy, and the GeoIP lookup. Issue #79 measured a launch making TEN — the release
 * lookup retried five times, plus a uBlock Origin download from addons.mozilla.org retried five times —
 * and nothing asserted it. Five of those survive on a HEALTHY launch with a valid engine, which is what
 * this guard pins.
 *
 * THE NUMBER, measured with the probe this guard replaces:
 *     empty root, no version.json        10 fetches   (release lookup 5 + addon download 5)
 *     root with files, no version.json    0 fetches   (refuses before any request)
 *     root with a valid version.json      5 fetches   (the addon download only)
 *
 * THE ASSERTION IS 5, NOT 0. Asserting zero would go GREEN while five requests remain, which is worse
 * than no guard because it is believed. 5 is today's honest number; it becomes 0 when uBlock Origin is
 * bundled instead of downloaded, and the print below is what makes that transition visible rather than
 * silent.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. It calls camoufox-js's `launchOptions()` directly against a
 * FIXTURE engine root, so it measures the LIBRARY, not the product's user-visible path — the product
 * reaches `launchOptions` through `resolveKernelForProfile`, which is a different question (see #79's
 * closure). What it defends is the outbound-request count, which is a property of the library call the
 * product makes on every launch.
 *
 * Usage: node packages/core/scripts/check-launch-fetches.mjs
 * Exits 0 when the count matches, 1 when it does not, 2 when the fixture could not be built.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** The number this guard pins. See the header for why it is not 0. */
const EXPECTED_FETCHES = 5

const root = mkdtempSync(path.join(os.tmpdir(), 'vfox-launch-fetches-'))
const engineDir = path.join(root, 'engine')
const launcherName = process.platform === 'win32' ? 'camoufox.exe' : 'camoufox'

// THE FIXTURE IS THREE FILES, and each was learned from a failure (AGENTS.md records them):
//   version.json    — two fields, `version` and `release`, NOT one combined string. Without a readable
//                     one, every launch reaches `camoufoxPath()` through the ADDON path and that
//                     function starts its own engine download: ten requests instead of five.
//   properties.json — camoufox-js validates the whole CAMOU_CONFIG against it and throws
//                     `UnknownProperty` for any key it does not list.
//   the launcher    — a real file, so `executable_path` is a fair argument.
mkdirSync(path.join(engineDir, 'addons'), { recursive: true })
writeFileSync(
  path.join(engineDir, 'version.json'),
  JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
)
// A schema that accepts anything the config might carry. The KEY SET is derived in the addons test;
// this guard is about the network, so a permissive schema keeps the two concerns apart — a missing key
// would otherwise fail here with a message about the config rather than about the fetch count.
writeFileSync(
  path.join(engineDir, 'properties.json'),
  JSON.stringify([{ property: 'addons', type: 'array' }]),
)
writeFileSync(path.join(engineDir, launcherName), 'a real file, so executable_path is meaningful\n')

if (!existsSync(path.join(engineDir, 'version.json'))) {
  console.error('fixture could not be built: no version.json')
  process.exit(2)
}

process.env.CAMOUFOX_INSTALL_DIR = engineDir

let fetches = 0
const requested = []
globalThis.fetch = async url => {
  fetches += 1
  requested.push(String(url).slice(0, 110))
  throw new Error('stubbed: this guard counts requests, it does not make them')
}

// The rejection arrives OUTSIDE the await — measured, and the reason the original probe printed nothing
// for the one state it was written for. Without these handlers the count is in hand and nothing reports.
let reported = false
function report(outcome) {
  if (reported) return
  reported = true
  console.log(`outbound requests from one launch: ${fetches} (expected ${EXPECTED_FETCHES})`)
  if (requested.length > 0) console.log(`  first request: ${requested[0]}`)
  if (outcome) console.log(`  outcome: ${String(outcome).split('\n')[0].slice(0, 120)}`)
  if (fetches !== EXPECTED_FETCHES) {
    console.error(
      `\nFAILED: expected ${EXPECTED_FETCHES} outbound request(s), counted ${fetches}.\n` +
        (fetches > EXPECTED_FETCHES
          ? '  More than expected: something new is reaching the network on every launch. The product\n' +
            '  rule allows exactly three outbound calls; a launch is not one of them.'
          : '  Fewer than expected: if uBlock Origin is now bundled rather than downloaded, this is the\n' +
            '  improvement the header describes — update EXPECTED_FETCHES to 0 in the same change.'),
    )
    process.exit(1)
  }
  console.log('OK — the launch makes the expected number of outbound requests')
  process.exit(0)
}

process.on('unhandledRejection', reason => report(`unhandledRejection: ${reason}`))
process.on('uncaughtException', error => report(`uncaughtException: ${error?.message ?? error}`))

const { launchOptions } = await import('camoufox-js')

try {
  await launchOptions({ executable_path: path.join(engineDir, launcherName) })
  report('ok')
} catch (error) {
  report(`threw: ${error?.message ?? error}`)
}

await new Promise(resolve => setTimeout(resolve, 1_500))
rmSync(root, { recursive: true, force: true })
report('no throw within 1.5 s of the await returning')
