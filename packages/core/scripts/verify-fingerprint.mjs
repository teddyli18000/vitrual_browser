#!/usr/bin/env node
/**
 * verify-fingerprint.mjs — read the LIVE fingerprint surface of a real profile and assert its
 * consistency properties; then, separately, report what two real sites did.
 *
 * WHY THIS EXISTS, AND WHY IT IS TWO THINGS
 *
 * The owner's GitHub login was risk-controlled with "Automated (bot) activity on your network
 * (IP 103.152.113.33)". Two independent causes were found, and this script deliberately keeps them
 * apart, because blurring them produces a test that fails for a reason nobody can fix — and the next
 * person "fixes" it by weakening the assertion.
 *
 *   (a) OURS — and the assertion for it was WITHDRAWN, which is the honest outcome. An
 *       `innerWidth/innerHeight > 0` property was written here and then removed, because it cannot go
 *       red against reality: `_castToProperties` filters falsy values (`if (!data) continue`) and
 *       `properties.json` carries no defaults, so the key never reaches CAMOU_CONFIG and Firefox
 *       reports its real viewport — measured at `inner 1770x1246` on the unfixed build. An assertion
 *       that cannot distinguish the state it names from any other state is decoration. The geometry
 *       property below is what actually holds that line.
 *   (b) NOT OURS. That IP is a US datacenter address (Fremont CA, AS46997 Black Mesa Corporation).
 *       GitHub's page named it. No browser change makes a hosting ASN look residential, and CI runs
 *       from a datacenter too — so the site check REPORTS what it saw rather than pretending a green
 *       result is achievable here.
 *
 * The property assertions are a pure function of a plain object, so the CHECKER WIRING can be
 * exercised without a browser. That is not coverage of reality: the live run is the coverage, and a
 * fixture only shows that an assertion is wired to the operands it names.
 *
 * Usage:
 *   node packages/core/scripts/verify-fingerprint.mjs --live             # launch a profile, read it
 *   node packages/core/scripts/verify-fingerprint.mjs --fixture geometry # wiring: inner > outer
 *   node packages/core/scripts/verify-fingerprint.mjs --fixture contradiction
 *   node packages/core/scripts/verify-fingerprint.mjs --fixture good
 *   …--skip-sites                                                        # properties only
 *
 * Build prerequisite: `pnpm --filter @vfox/core build` (this imports ../dist/index.js).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Every site, in one list.
 *
 * `kind` is one of:
 *   - `oracle`  — a third-party checker. It FAILS the run when it names a concrete inconsistency of
 *                 ours, because those are actionable and ours.
 *   - `login`   — a real target whose success condition is a rendered login form. It REPORTS: a
 *                 datacenter ASN blocking us is expected from CI and no browser change fixes it.
 *
 * Extraction is text-based rather than selector-based on purpose: third-party selectors change
 * without telling us, and a text parse that stops matching degrades to UNREAD (visible) rather than
 * silently matching nothing (invisible).
 */
const SITE_TARGETS = [
  {
    name: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    kind: 'oracle',
    parse: 'creepjs',
    waitMs: 12_000,
  },
  {
    name: 'sannysoft',
    url: 'https://bot.sannysoft.com/',
    kind: 'oracle',
    parse: 'sannysoft',
    waitMs: 4_000,
  },
  {
    name: 'browserscan',
    url: 'https://browserscan.net/bot-detection',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 8_000,
  },
  {
    name: 'pixelscan',
    url: 'https://pixelscan.net/fingerprint-check',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 8_000,
  },
  {
    name: 'deviceandbrowserinfo',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 8_000,
  },
  {
    name: 'github-login',
    url: 'https://github.com/login',
    kind: 'login',
    waitMs: 0,
  },
  // TODO(lead): the WorkBuddy real target. Its URL has still not been supplied. Kept here so the
  // configured count stays visible in the output and an incomplete run never reads as a complete pass.
  // { name: 'workbuddy', url: '<exact URL pending>', kind: 'login', waitMs: 0 },
]

/** How many targets this runner is designed to cover, so "incomplete" is measurable. */
const EXPECTED_TARGET_COUNT = 7

/** The fields read from the page. Kept here so the live read and the fixtures cannot drift. */
const SURFACE_FIELDS = [
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'screenWidth',
  'screenHeight',
  'screenAvailWidth',
  'screenAvailHeight',
  'devicePixelRatio',
  'userAgent',
  'platform',
  'oscpu',
  'languages',
  'timezone',
  'webdriver',
  'hardwareConcurrency',
  'webglVendor',
  'webglRenderer',
]

const failures = []
const notes = []

function note(message) {
  notes.push(message)
  console.log(`note  ${message}`)
}
function check(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures.push(`${name}: ${detail}`)
  return passed
}

/* ------------------------------------------------------------------ the consistency properties */

/** Which OS a `navigator.platform` value claims. */
function platformFamily(platform) {
  const value = String(platform ?? '')
  if (/^Win/i.test(value)) return 'windows'
  if (/^Mac/i.test(value)) return 'macos'
  if (/^Linux/i.test(value)) return 'linux'
  return 'unknown'
}

/** Which OS a user agent claims. */
function userAgentFamily(userAgent) {
  const value = String(userAgent ?? '')
  if (/Windows/i.test(value)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(value)) return 'macos'
  if (/Linux|X11/i.test(value)) return 'linux'
  return 'unknown'
}

/** Which OS `navigator.oscpu` claims. */
function oscpuFamily(oscpu) {
  const value = String(oscpu ?? '')
  if (/Windows/i.test(value)) return 'windows'
  if (/Mac|Darwin|PPC/i.test(value)) return 'macos'
  if (/Linux/i.test(value)) return 'linux'
  return 'unknown'
}

/** Whether an IANA zone name is one the runtime actually accepts. */
function isKnownTimeZone(zone) {
  if (typeof zone !== 'string' || !zone.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The property assertions. A pure function of the surface object — deliberately: it is what lets a
 * failing case be demonstrated without a browser, and it keeps the browser out of the logic.
 *
 * @param {Record<string, unknown>} surface
 * @returns {boolean} whether every property held
 */
function checkConsistencyProperties(surface) {
  const number = key => Number(surface[key])

  // THE geometry property, and the only one here that does geometry. `outerWidth` is OUR pinned
  // number from the profile's config while `innerWidth` is the viewport the browser actually has, so
  // this goes red the moment those two disagree — an inner box wider than the window we claim to have
  // set. Same inconsistency class as the chrome check, and the reason it is expressed as a
  // relationship between two independently-sourced numbers rather than as a range.
  check(
    'inner box fits inside the outer box',
    number('innerWidth') <= number('outerWidth') && number('innerHeight') <= number('outerHeight'),
    `inner ${surface.innerWidth}x${surface.innerHeight} vs outer ${surface.outerWidth}x${surface.outerHeight}`,
  )

  check(
    'outer box fits on the screen',
    number('outerWidth') <= number('screenWidth') &&
      number('outerHeight') <= number('screenAvailHeight'),
    `outer ${surface.outerWidth}x${surface.outerHeight} vs screen ${surface.screenWidth}x` +
      `${surface.screenAvailHeight} (avail)`,
  )

  // A real ratio, never 0 or NaN. 0 is what a detached or unrendered window reports.
  const ratio = number('devicePixelRatio')
  check(
    'devicePixelRatio is a real ratio',
    Number.isFinite(ratio) && ratio > 0 && ratio <= 8,
    `devicePixelRatio=${surface.devicePixelRatio}`,
  )

  check(
    'navigator.webdriver is false',
    surface.webdriver === false,
    `webdriver=${JSON.stringify(surface.webdriver)}`,
  )

  // Valid IANA zone, but deliberately NOT a specific zone: with geoip on and no proxy, the engine
  // derives it from the local IP, so the correct value depends on where this runs.
  check(
    'timezone is a valid IANA zone',
    isKnownTimeZone(surface.timezone),
    `timezone=${JSON.stringify(surface.timezone)}`,
  )
  note(`resolved timezone: ${JSON.stringify(surface.timezone)} (not asserted to a specific zone)`)

  // The contradiction class this whole exercise is about: a UA claiming one OS while the platform
  // and oscpu claim another.
  const fromUserAgent = userAgentFamily(surface.userAgent)
  const fromPlatform = platformFamily(surface.platform)
  const fromOscpu = oscpuFamily(surface.oscpu)
  check(
    'the UA, platform and oscpu agree on the operating system',
    fromUserAgent !== 'unknown' &&
      fromUserAgent === fromPlatform &&
      (fromOscpu === 'unknown' || fromOscpu === fromUserAgent),
    `ua=${fromUserAgent} platform=${fromPlatform} (${surface.platform}) oscpu=${fromOscpu} (${surface.oscpu})`,
  )

  check(
    'the WebGL vendor and renderer are both readable',
    Boolean(surface.webglVendor) && Boolean(surface.webglRenderer),
    `${surface.webglVendor} / ${surface.webglRenderer}`,
  )

  return failures.length === 0
}

/* ------------------------------------------------------------------------------- the live read */

/** Read the whole surface from inside the page. */
async function readSurface(page) {
  return page.evaluate(() => {
    // Two SEPARATE canvas elements: a canvas has exactly one context type, so reading `webgl` from
    // an element that already has a `2d` context returns null.
    const gl = document.createElement('canvas').getContext('webgl')
    const debug = gl?.getExtension('WEBGL_debug_renderer_info')
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenAvailWidth: screen.availWidth,
      screenAvailHeight: screen.availHeight,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      oscpu: navigator.oscpu ?? null,
      languages: (navigator.languages ?? []).join(','),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webglVendor: debug
        ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
        : (gl?.getParameter(gl.VENDOR) ?? null),
      webglRenderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : (gl?.getParameter(gl.RENDERER) ?? null),
    }
  })
}

/** A surface where every property holds, used by `--fixture good`. */
const GOOD_FIXTURE = {
  innerWidth: 1280,
  innerHeight: 720,
  outerWidth: 1280,
  outerHeight: 800,
  screenWidth: 1920,
  screenHeight: 1080,
  screenAvailWidth: 1920,
  screenAvailHeight: 1040,
  devicePixelRatio: 1,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
  platform: 'Win32',
  oscpu: 'Windows NT 10.0; Win64; x64',
  languages: 'en-US,en',
  timezone: 'Etc/UTC',
  webdriver: false,
  hardwareConcurrency: 8,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar',
}

/**
 * The geometry property, deliberately broken: the viewport is wider than the window we claim to have
 * pinned. This exercises the CHECKER WIRING; it does not claim a real launch can produce this state.
 * The live run is the coverage.
 *
 * There is deliberately no `innerWidth = 0` fixture. The engine cannot produce that state, so an
 * assertion against it could never go red against reality, and it was removed for that reason.
 */
const GEOMETRY_FIXTURE = { ...GOOD_FIXTURE, innerWidth: 1900, innerHeight: 1400 }

/**
 * Every geometric property holds, and the OS claims contradict each other: the UA says Macintosh
 * while `platform` and `oscpu` say Windows. That is the contradiction class this whole exercise is
 * about, and it is a different assertion from the geometry one.
 */
const CONTRADICTION_FIXTURE = {
  ...GOOD_FIXTURE,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
  platform: 'Win32',
  oscpu: 'Windows NT 10.0; Win64; x64',
}

/** Declared after every fixture it references: a `const` used before its declaration is a TDZ error. */
const FIXTURES = {
  good: GOOD_FIXTURE,
  geometry: GEOMETRY_FIXTURE,
  contradiction: CONTRADICTION_FIXTURE,
}

/* ------------------------------------------------------------------------------- the site check */

/** The IP this machine exits from, or null when that cannot be determined. */
async function exitIp() {
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) continue
      const text = (await response.text()).trim()
      const parsed = text.startsWith('{') ? JSON.parse(text).ip : text
      if (parsed) return parsed
    } catch {
      // Try the next one.
    }
  }
  return null
}

/** Heuristics for "this is a risk-control page, not the page we asked for". */
const INTERSTITIAL_SIGNATURES = [
  /automated \(bot\) activity/i,
  /unusual traffic/i,
  /verify your (identity|account)/i,
  /risk.?control/i,
  /are you a robot/i,
  /suspended/i,
]

/** Markers an oracle page uses to say "this browser is automated". */
const AUTOMATION_MARKERS = [
  /\byou are (a )?bot\b/i,
  /\bbot detected\b/i,
  /\bautomation (detected|flag|tool)/i,
  /\bautomated\b/i,
  /\bheadless\b/i,
  /\bwebdriver\b/i,
  /\bselenium\b/i,
  /\bpuppeteer\b/i,
]

/** Markers an oracle page uses to say "nothing suspicious found". */
const CLEAN_MARKERS = [
  /\bnot a bot\b/i,
  /\bno automation\b/i,
  /\byou are human\b/i,
  /\bpassed\b/i,
  /\bconsistent\b/i,
  /\bno (mismatch|inconsistenc|contradiction)/i,
]

/**
 * Read a verdict out of an oracle page's text.
 *
 * A **pure function of the page text**, deliberately: it is what lets the oracle path be shown going
 * red on a deliberately bad surface without a browser. See `--oracle-fixture`.
 *
 * The three outcomes are the point. `UNREAD` is neither a pass nor a fail — a site whose verdict
 * cannot be extracted must never look like a pass, because that is how a decorative guard is born
 * (the packaging guard that scanned zero modules and passed everything).
 *
 * @param {string} kind @param {string} text
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'UNREAD', finding: string }}
 */
function parsePageVerdict(kind, text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const preview = flat.slice(0, 200)

  if (kind === 'creepjs') {
    // CreepJS labels the count before the number ("Lies 2") in some layouts and after it in others
    // ("2 lies"). Both are handled; anything else is UNREAD rather than assumed clean.
    const counted = /\b(\d+)\s+lies?\b/i.exec(flat)
    const labelled = counted ? null : /\blies?\b[^\d]{0,12}(\d+)/i.exec(flat)
    const lies = counted ?? labelled
    if (!lies) {
      return {
        verdict: 'UNREAD',
        finding: `no lie count on the page; first 200 characters: ${preview}`,
      }
    }
    if (Number(lies[1]) === 0) return { verdict: 'PASS', finding: 'reports 0 lies' }
    return {
      verdict: 'FAIL',
      finding: `reports ${lies[1]} lie(s) — the named contradictions are ours: ${flat.slice(lies.index, lies.index + 400)}`,
    }
  }

  if (kind === 'sannysoft') {
    // A check table: each row label is followed by its result. Match the label that precedes "failed"
    // rather than splitting on separators, which cut labels in half.
    const failed = [...flat.matchAll(/([A-Za-z][\w ()./#-]{1,50}?)\s+failed\b/gi)].map(match =>
      match[1].replace(/^.*[|\n]\s*/, '').trim(),
    )
    if (failed.length > 0) {
      return {
        verdict: 'FAIL',
        finding: `${failed.length} failed check(s): ${failed.slice(0, 8).join(' | ')}`,
      }
    }
    if (/\bpassed\b/i.test(flat)) {
      return { verdict: 'PASS', finding: 'no failed rows in the check table' }
    }
    return { verdict: 'UNREAD', finding: `no check table found; first 200 characters: ${preview}` }
  }

  // Generic oracle. The STRONG markers are checked before the generic ones on purpose: "0 automation
  // flags detected" is a clean statement that happens to contain the word "automation", and matching
  // it as a failure would make this run red for no reason — a false FAIL is as corrosive as a false
  // pass, because the next person turns the check off.
  const strongBot = /\b(you are (a )?bot|bot detected|automation detected)\b/i.exec(flat)
  if (strongBot) {
    return {
      verdict: 'FAIL',
      finding: `automation flag on the page: "${flat.slice(Math.max(0, strongBot.index - 60), strongBot.index + 140)}"`,
    }
  }
  const strongClean =
    /\b(not a bot|no automation|0 automation|you are human|nothing suspicious)\b/i.exec(flat)
  if (strongClean) {
    return {
      verdict: 'PASS',
      finding: `page says: "${flat.slice(Math.max(0, strongClean.index - 40), strongClean.index + 120)}"`,
    }
  }

  const automation = AUTOMATION_MARKERS.find(pattern => pattern.test(flat))
  if (automation) {
    const at = flat.search(automation)
    return {
      verdict: 'FAIL',
      finding: `automation flag on the page: "${flat.slice(Math.max(0, at - 60), at + 140)}"`,
    }
  }
  const clean = CLEAN_MARKERS.find(pattern => pattern.test(flat))
  if (clean) {
    const at = flat.search(clean)
    return {
      verdict: 'PASS',
      finding: `page says: "${flat.slice(Math.max(0, at - 40), at + 120)}"`,
    }
  }
  return {
    verdict: 'UNREAD',
    finding: `neither an automation marker nor a clean marker was present; first 200 characters: ${preview}`,
  }
}

/** Which parser an oracle fixture exercises. */
const ORACLE_FIXTURE_KINDS = {
  'creepjs-lies': 'creepjs',
  'sannysoft-failed': 'sannysoft',
}

/** Synthetic pages proving the oracle parser can go red — and that UNREAD is reachable. */
const ORACLE_FIXTURES = {
  'creepjs-lies':
    'Trust score 42% Lies 2 webDriver: true platform: Win32 but userAgent says Macintosh resistance 3.1',
  'sannysoft-failed':
    'WebDriver (New) failed | Chrome (New) failed | Permissions passed | Plugins passed',
  'clean-oracle': 'You are not a bot 0 automation flags detected consistent fingerprint',
  unreadable: 'Loading…',
}

/**
 * Run every target and print one table.
 *
 * One target failing, timing out or being blocked NEVER aborts the others, and every target appears
 * in the table with its verdict and its specific finding — including the ones that could not be read.
 */
async function checkTargets(browser, propertiesHeld) {
  const ip = await exitIp()
  console.log('')
  console.log(`=== site check (exit IP ${ip ?? 'could not be determined'})`)
  if (SITE_TARGETS.length < EXPECTED_TARGET_COUNT) {
    console.log(
      `note  only ${SITE_TARGETS.length} of ${EXPECTED_TARGET_COUNT} targets are configured ` +
        `(${EXPECTED_TARGET_COUNT - SITE_TARGETS.length} pending); this run is INCOMPLETE`,
    )
  }

  const rows = []
  for (const target of SITE_TARGETS) {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = await context.newPage()
    try {
      const response = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      // A fixed settle rather than a network-idle wait: these sites keep a connection open, so
      // `networkidle` would never fire.
      if (target.waitMs > 0) await page.waitForTimeout(target.waitMs)
      const text =
        (await page
          .locator('body')
          .innerText()
          .catch(() => '')) || ''
      const interstitial = INTERSTITIAL_SIGNATURES.find(pattern => pattern.test(text))

      if (target.kind === 'login') {
        if (interstitial) {
          rows.push({
            name: target.name,
            verdict: 'REPORT',
            finding:
              `RISK CONTROL from ${ip ?? 'unknown'} (status ${response?.status() ?? '?'}); the page ` +
              `says: "${text.replace(/\s+/g, ' ').slice(0, 200)}"`,
          })
          note(
            `${target.name} served a risk-control page from ${ip ?? 'unknown'}. That is the ` +
              'datacenter ASN, not a fingerprint defect — no browser change alters where CI exits from.',
          )
          continue
        }
        const password = await page.locator('input[type="password"]').count()
        const username =
          (await page
            .locator('input[name="login"], input#login_field, input[type="email"]')
            .count()) > 0
        if (password > 0 && username) {
          rows.push({ name: target.name, verdict: 'PASS', finding: 'the login form rendered' })
        } else if (propertiesHeld) {
          const finding =
            'the login form did not render while every fingerprint property passed, so this is on ' +
            `our side. Title "${await page.title()}"`
          rows.push({ name: target.name, verdict: 'FAIL', finding })
          failures.push(`${target.name}: ${finding}`)
        } else {
          rows.push({
            name: target.name,
            verdict: 'REPORT',
            finding:
              'no login form, but a fingerprint property already failed, so this is not an ' +
              'independent defect',
          })
        }
        continue
      }

      // An oracle site: an interstitial is a REPORT (not ours), otherwise read the verdict.
      if (interstitial) {
        rows.push({
          name: target.name,
          verdict: 'REPORT',
          finding:
            `the oracle served a risk-control/interstitial page from ${ip ?? 'unknown'}, so no ` +
            `verdict can be read. It says: "${text.replace(/\s+/g, ' ').slice(0, 200)}"`,
        })
        continue
      }

      const parsed = parsePageVerdict(target.parse, text)
      rows.push({ name: target.name, verdict: parsed.verdict, finding: parsed.finding })
      if (parsed.verdict === 'FAIL') {
        failures.push(`${target.name} (oracle) named an inconsistency of ours: ${parsed.finding}`)
      }
      if (parsed.verdict === 'UNREAD') {
        note(
          `${target.name}: the verdict could NOT be read. That is neither a pass nor a fail — the ` +
            'extraction for this site needs updating, and until then this site proves nothing.',
        )
      }
    } catch (error) {
      // Unreachable, timed out, crashed — never aborts the remaining targets.
      const message = String(error?.message ?? error).split('\n')[0]
      const unreachable = /timeout|ENOTFOUND|ECONNREFUSED|ERR_|net::/i.test(message)
      rows.push({
        name: target.name,
        verdict: unreachable ? 'UNREACHABLE' : 'UNREAD',
        finding: `${message} (from ${ip ?? 'unknown'})`,
      })
      note(`${target.name} could not be read from ${ip ?? 'unknown'}: ${message}`)
    } finally {
      await page.close().catch(() => {})
    }
  }

  console.log('')
  const width = Math.max(...rows.map(row => row.name.length), 'target'.length)
  console.log(`${'target'.padEnd(width)}  ${'verdict'.padEnd(11)}  finding`)
  console.log(`${'-'.repeat(width)}  ${'-'.repeat(11)}  ${'-'.repeat(40)}`)
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${row.verdict.padEnd(11)}  ${row.finding}`)
  }

  const counts = {}
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
  console.log('')
  console.log(
    `summary: ${Object.entries(counts)
      .map(([verdict, count]) => `${count} ${verdict}`)
      .join(', ')}`,
  )
  // The honesty line, in the runner's own output rather than only in a PR description.
  console.log(
    'LIMIT: a green oracle result is one third-party opinion, on one day, from one datacenter IP.\n' +
      '       It is not proof of undetectability. A PASS means these particular checks, run today\n' +
      '       from this IP, named nothing — and an UNREAD means the site proved nothing at all.',
  )

  const unread = rows.filter(row => row.verdict === 'UNREAD' || row.verdict === 'UNREACHABLE')
  if (unread.length > 0) {
    note(
      `${unread.length} of ${rows.length} targets could not be read ` +
        `(${unread.map(row => row.name).join(', ')}). Neither passes nor failures, and not coverage.`,
    )
  }
}

/* ---------------------------------------------------------------------------------------- main */

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const fixture = argument('fixture')
const oracleFixture = argument('oracle-fixture')
const live = process.argv.includes('--live')
const skipSites = process.argv.includes('--skip-sites')

if (!fixture && !live && !oracleFixture) {
  console.error(
    `usage: verify-fingerprint.mjs --live | --fixture ${Object.keys(FIXTURES).join('|')} | ` +
      `--oracle-fixture ${Object.keys(ORACLE_FIXTURES).join('|')} [--skip-sites]`,
  )
  process.exit(2)
}

// The counterfactual for the ORACLE path: drive the verdict parser with a synthetic page, so "an
// oracle can fail us" is demonstrable without a browser. Same parser the live oracles use.
if (oracleFixture) {
  if (!Object.hasOwn(ORACLE_FIXTURES, oracleFixture)) {
    console.error(
      `unknown oracle fixture "${oracleFixture}"; expected one of ${Object.keys(ORACLE_FIXTURES).join(', ')}`,
    )
    process.exit(2)
  }
  const text = ORACLE_FIXTURES[oracleFixture]
  const kind = ORACLE_FIXTURE_KINDS[oracleFixture] ?? 'generic'
  console.log(`=== oracle fixture (${oracleFixture}, parsed as "${kind}") — no browser needed`)
  console.log(`      page text: ${JSON.stringify(text)}`)
  const parsed = parsePageVerdict(kind, text)
  console.log(`      verdict:   ${parsed.verdict}`)
  console.log(`      finding:   ${parsed.finding}`)
  if (parsed.verdict === 'FAIL') failures.push(`oracle fixture ${oracleFixture}: ${parsed.finding}`)
  report()
}

let surface
let browser = null
let closeCore = null

if (fixture) {
  if (!Object.hasOwn(FIXTURES, fixture)) {
    console.error(
      `unknown fixture "${fixture}"; expected one of ${Object.keys(FIXTURES).join(', ')}`,
    )
    process.exit(2)
  }
  surface = FIXTURES[fixture]
  console.log(
    `=== fixture mode (${fixture}) — no browser, but the same assertions the live run uses`,
  )
} else {
  const headless = /^(1|true|yes|on)$/i.test(process.env.VFOX_SMOKE_HEADLESS ?? '')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vfox-fingerprint-'))
  console.log(`=== live mode (data dir ${dataDir}, headless ${headless})`)

  const { createCore } = await import('../dist/index.js')
  const core = await createCore({ dataDir })
  const profile = await core.profiles.create({
    name: `verify-fingerprint-${Date.now()}`,
    launch: { headless, startUrl: 'about:blank' },
  })

  closeCore = async () => {
    await core.runtime.stop(profile.id).catch(() => {})
    await core.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  // `runtime.launch` THROWS when the engine cannot start, rather than returning a status — verified:
  // without this catch the spawn failure arrives as an uncaught exception and a stack trace, which
  // is exactly the kind of output that gets misread as a fingerprint defect.
  let runtime
  try {
    runtime = await core.runtime.launch(profile.id)
  } catch (error) {
    console.error(`FAIL  the profile could not be launched: ${error.message}`)
    console.error(
      "      A browser cannot start in this project's local sandbox, so this is expected here and\n" +
        '      is the finding in CI. Run it in CI or on an unconfined machine.',
    )
    await closeCore()
    process.exit(2)
  }

  if (runtime.status !== 'running' || !runtime.wsEndpoint) {
    console.error(`FAIL  the profile did not launch with a wsEndpoint (status ${runtime.status}).`)
    await closeCore()
    process.exit(2)
  }

  const { firefox } = await import('playwright-core')
  browser = await firefox.connect(runtime.wsEndpoint)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()
  await page.goto('about:blank', { waitUntil: 'load' })
  surface = await readSurface(page)
}

console.log('')
console.log('=== fingerprint surface')
for (const field of SURFACE_FIELDS) console.log(`      ${field}: ${JSON.stringify(surface[field])}`)

console.log('')
console.log('=== consistency properties')
const held = checkConsistencyProperties(surface)

if (browser && !skipSites) {
  await checkTargets(browser, held)
} else if (!browser) {
  note('fixture mode: the real site check needs a browser and was not run')
} else {
  note('the site check was skipped with --skip-sites')
}

await closeCore?.()
report()

/** Print the summary and exit appropriately. */
function report() {
  console.log('')
  console.log('='.repeat(72))
  if (notes.length > 0) {
    console.log(`notes (${notes.length}):`)
    for (const entry of notes) console.log(`  - ${entry}`)
  }
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('all fingerprint consistency properties hold')
  process.exit(0)
}
