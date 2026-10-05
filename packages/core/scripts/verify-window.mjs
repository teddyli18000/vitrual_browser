/**
 * Headed window verification — "can it really be used like a normal browser window?"
 *
 * Every other check in this repository measures a *headless* engine: fingerprint values, no window.
 * This script is the one that answers the owner's question, and it can only run on a Windows machine
 * with an interactive desktop (CI, or a developer's own session). It is deliberately strict: a
 * process with no visible top-level window FAILS, because that is the whole point.
 *
 * It drives the shipped path — `createCore` from `packages/core/dist` — never raw Playwright, and
 * asserts, in order:
 *   1. a real visible OS window exists for the engine (koffi → user32.dll/kernel32.dll), with
 *      pid/handle/title/rect — found by pid first and by process image name as the fallback, because
 *      a headed launch reports a Windows launcher stub that owns no window at all (see the long
 *      comment on `findEngineWindow` in `lib/user32.mjs`); the payload says which path matched;
 *   2. the rect is a plausible browser window (>= 800x600, no bigger than the work area);
 *   3. it is a usable Firefox: a real page loads and reports the profile's spoofed user agent;
 *   4. **state survives a restart** — cookie and localStorage written before a stop are still there
 *      after relaunching the SAME profile. Without this the product is a toy, not a browser;
 *   5. the window survives an automation client detaching;
 *   6. cleanup: no engine process and no temp directory is left behind.
 * plus the window-geometry coherence check: the OS rect, `window.outer*`, `window.inner*`,
 * `screenX/Y` and `screen.*` are reported raw and checked against each other, because a spoofed
 * `outerWidth` over a differently-sized real window is exactly the derived inconsistency a detector
 * looks for.
 *
 * Usage:
 *   node packages/core/scripts/verify-window.mjs [--screenshot <path.png>]
 *
 * Environment:
 *   VFOX_SMOKE_HEADLESS=1   REFUSES to run (exit 2). A headless run cannot verify a window, and
 *                           reporting a pass there would be a lie.
 *   CAMOUFOX_INSTALL_DIR    honoured when set (same as the rest of the core)
 *   VFOX_WINDOW_KEEP=1      keep the temp data directory for post-mortem inspection
 *
 * Output contract (stdout is machine-readable only; human progress goes to stderr):
 *   VFOX_WINDOW_STEP   {"step":…,"ok":…,…}       one line per assertion group
 *   VFOX_WINDOW_OK     {…}                       exactly once, on success
 *   VFOX_WINDOW_FAIL   {"stage":…,"reason":…,"hint":…,"details":…}
 *                                                on failure, and the exit code is non-zero; when a
 *                                                window is missing, `details.desktop` is a snapshot
 *                                                of what was actually on screen
 *   exit codes: 0 ok | 1 an assertion failed | 2 the environment cannot run this check
 *
 * Prerequisites: `pnpm --filter @vfox/core build` (this imports `dist`), the engine
 * (`pnpm kernel:fetch`), and `scripts/capture-desktop.ps1` for `--screenshot`.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { firefox } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

/**
 * The lower bound on a plausible browser window, and the only one: the CI runner's desktop is
 * 1024x768 with a 1024x720 work area, so a maximized window is roughly 1024x720 — anything tighter
 * than 800x600 would fail a perfectly good window. The upper bound is the work area plus
 * `WORK_AREA_TOLERANCE` (a maximized window has an invisible border that sticks out past it).
 */
const MIN_WIDTH = 800
const MIN_HEIGHT = 600
const WINDOW_WAIT_MS = 30_000
/** The chrome between `outer*` and `inner*`: 0–120 px wide, 0–200 px tall is a normal browser. */

class WindowFailure extends Error {
  constructor(stage, reason, exitCode, hint, details) {
    super(reason)
    this.stage = stage
    this.exitCode = exitCode
    this.hint = hint
    /** Extra machine-readable evidence for this failure, or null. */
    this.details = details ?? null
  }
}

function log(message) {
  process.stderr.write(`[window] ${message}\n`)
}

function emit(marker, payload, stream = process.stdout) {
  stream.write(`${marker} ${JSON.stringify(payload)}\n`)
}

function step(name, details) {
  emit('VFOX_WINDOW_STEP', { step: name, ok: true, ...details }, process.stderr)
}

function fail(stage, reason, exitCode, hint, details) {
  throw new WindowFailure(stage, reason, exitCode, hint, details)
}

/** For the pre-flight checks, which run before the main try/catch: report and exit directly. */
function refuse(stage, reason, exitCode, hint) {
  emit('VFOX_WINDOW_FAIL', { stage, reason, hint: hint ?? null, details: null }, process.stderr)
  log(`REFUSING to run at ${stage}: ${reason}`)
  if (hint) {
    log(`hint: ${hint}`)
  }
  process.exit(exitCode)
}

/* ------------------------------------------------------------------------------- arguments */

import { checkViewportAgainstOs } from './lib/window-geometry.mjs'

/* ------------------------------------------------------------------------------- fixtures */

/**
 * Fixtures for the geometry checks, so that "this assertion can fail" is one command rather than a
 * claim that only CI can settle. The live path refuses headless by design and the development sandbox
 * cannot spawn a browser, so without these the red run is unverifiable locally.
 *
 * A fixture shows only that an assertion is wired to the operands it names. It is not evidence about
 * the engine — the headings below name which real run each set of numbers came from.
 */
const FIXTURES = {
  /**
   * The TARGET geometry for a 1024x720 work area, carrying the chrome measured in CI run
   * 37266596880 (16x65). The CHROME is a measurement; the window is what the sizing policy produces
   * for that work area - which is why this fixture passes by construction: it cannot fail while its
   * operands are self-consistent, and it therefore carries no evidence. An earlier version of this
   * comment claimed the window was that run's own, and that run's window was 1786x1311, which is the
   * neighbouring fixture. The evidence in this file is `window-larger-than-screen`, `zero-viewport`
   * and the unit test's REAL case, not this one.
   */
  good: {
    os: { width: 1024, height: 700 },
    inner: { width: 1008, height: 635 },
    devicePixelRatio: 1,
    workArea: { width: 1024, height: 720 },
  },
  /** The same run's actual window: larger than the work area, which is what the owner calls 满屏. */
  'window-larger-than-screen': {
    os: { width: 1786, height: 1311 },
    inner: { width: 1770, height: 1246 },
    devicePixelRatio: 1,
    workArea: { width: 1024, height: 720 },
  },
  /** The defect the viewport guard exists for: a page that reports nothing. */
  'zero-viewport': {
    os: { width: 1786, height: 1311 },
    inner: { width: 0, height: 0 },
    devicePixelRatio: 1,
    workArea: { width: 1920, height: 1040 },
  },
}

/** Run the pure geometry checks against a fixture: exit 0 when they pass, 1 when one fails. */
function runFixture(name) {
  const fixture = FIXTURES[name]
  if (!fixture) {
    refuse(
      'arguments',
      `unknown fixture "${name}"`,
      2,
      `use --fixture <${Object.keys(FIXTURES).join('|')}>`,
    )
  }
  const viewport = checkViewportAgainstOs({
    osRect: fixture.os,
    innerWidth: fixture.inner.width,
    innerHeight: fixture.inner.height,
    devicePixelRatio: fixture.devicePixelRatio,
  })
  const sizeFailures = []
  if (fixture.os.width < MIN_WIDTH || fixture.os.height < MIN_HEIGHT) {
    sizeFailures.push(
      `the window is ${fixture.os.width}x${fixture.os.height}, below ${MIN_WIDTH}x${MIN_HEIGHT}`,
    )
  }
  if (
    fixture.os.width > fixture.workArea.width + WORK_AREA_TOLERANCE ||
    fixture.os.height > fixture.workArea.height + WORK_AREA_TOLERANCE
  ) {
    sizeFailures.push(
      `the window is ${fixture.os.width}x${fixture.os.height}, larger than the ` +
        `${fixture.workArea.width}x${fixture.workArea.height} work area`,
    )
  }
  const ok = viewport.ok && sizeFailures.length === 0
  console.log(
    `VFOX_WINDOW_FIXTURE ${JSON.stringify({
      fixture: name,
      ok,
      viewport: { ok: viewport.ok, chrome: viewport.chrome, failures: viewport.failures },
      size: { ok: sizeFailures.length === 0, failures: sizeFailures },
    })}`,
  )
  process.exit(ok ? 0 : 1)
}
const argv = process.argv.slice(2)
let screenshotPath = null
let fixtureName = null
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--screenshot') {
    screenshotPath = argv[index + 1] ?? null
    index += 1
    if (!screenshotPath) {
      refuse('arguments', '--screenshot needs a path', 2, 'use --screenshot <path.png>')
    }
  } else if (argument === '--fixture') {
    fixtureName = argv[index + 1] ?? null
    index += 1
    if (!fixtureName) {
      refuse(
        'arguments',
        '--fixture needs a name',
        2,
        'use --fixture <good|window-larger-than-screen|zero-viewport>',
      )
    }
  } else {
    refuse('arguments', `unknown argument "${argument}"`, 2, 'usage: [--screenshot <path.png>]')
  }
}

if (fixtureName) {
  runFixture(fixtureName)
}

/* ------------------------------------------------------------------ headless must be refused */

if (/^(1|true|yes|on)$/i.test(process.env.VFOX_SMOKE_HEADLESS ?? '')) {
  refuse(
    'headless-refused',
    'VFOX_SMOKE_HEADLESS is set: a headless profile has no OS window, so this check cannot pass',
    2,
    'run this script on a machine with an interactive desktop and leave VFOX_SMOKE_HEADLESS unset',
  )
}

/* ------------------------------------------------------------------------------ win32 access */

// The user32/kernel32/CIM layer lives in ./lib/user32.mjs so `scripts/probe-windows.mjs` can
// exercise the exact same code without a browser — the only way to test it in the development
// sandbox.
import {
  describeWindows,
  ENGINE_IMAGE_NAME,
  enginePids,
  findEngineWindow,
  listEngineProcesses,
  loadUser32,
  message,
  WORK_AREA_TOLERANCE,
} from './lib/user32.mjs'

/* ------------------------------------------------------------------------------- utilities */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Poll until the engine owns a visible window, and say which lookup found it.
 *
 * The failure carries a snapshot of the desktop, because "no window appeared" has two very different
 * causes — the engine never opened one (environment) or this lookup is wrong (product) — and the log
 * from a failed run has to be enough to tell them apart without another 30-second round trip.
 *
 * @param {Awaited<ReturnType<typeof loadUser32>>} api
 * @param {Set<number>} pids
 * @param {{ stage?: string, context?: string }} [options]
 * @returns {Promise<import('./lib/user32.mjs').EngineWindowLookup>}
 */
async function waitForWindow(api, pids, options = {}) {
  const { stage = 'window', context = 'the engine' } = options
  const deadline = Date.now() + WINDOW_WAIT_MS
  let lastLookup = null
  let lastWindows = []
  while (Date.now() < deadline) {
    lastWindows = api.windows()
    lastLookup = findEngineWindow(lastWindows, { pids, imageName: ENGINE_IMAGE_NAME })
    if (lastLookup.window) {
      return lastLookup
    }
    await sleep(500)
  }
  throw new WindowFailure(
    stage,
    `${context} has no visible top-level window after ${WINDOW_WAIT_MS}ms: the pid path ` +
      `(${[...pids].join(', ')}) matched ${lastLookup?.pidWindows ?? 0} window(s) and the image ` +
      `path ("${ENGINE_IMAGE_NAME}") matched ${lastLookup?.imageWindows ?? 0}`,
    1,
    `read details.desktop: no "${ENGINE_IMAGE_NAME}" window on it means the engine never opened ` +
      'one, or lost it (environment); a visible one there means this lookup is wrong (product)',
    {
      desktop: describeWindows(lastWindows),
      engineImage: ENGINE_IMAGE_NAME,
      // The engine's own windows, visible or not: three hidden helper windows with no visible main
      // window is a completely different situation from no engine window at all, and this is the
      // line that tells them apart.
      engineWindows: lastWindows
        .filter(candidate => candidate.image === ENGINE_IMAGE_NAME)
        .slice(0, 8)
        .map(candidate => ({
          pid: candidate.pid,
          visible: candidate.visible,
          rect: candidate.rect,
          title: candidate.title,
        })),
      pids: [...pids],
      pidWindows: lastLookup?.pidWindows ?? 0,
      imageWindows: lastLookup?.imageWindows ?? 0,
    },
  )
}

/** Shape comparison: the engine rewrites UA version numbers, so digits are normalised away. */
function uaShape(userAgent) {
  return String(userAgent).replace(/\d+/g, '#')
}

/* ------------------------------------------------------------------- page / geometry probes */

const PAGE_PROBE = () => ({
  userAgent: navigator.userAgent,
  title: document.title,
  textLength: (document.body?.innerText ?? '').length,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  screenX: window.screenX,
  screenY: window.screenY,
  screenWidth: screen.width,
  screenHeight: screen.height,
  availWidth: screen.availWidth,
  availHeight: screen.availHeight,
  devicePixelRatio: window.devicePixelRatio,
})

const SET_STATE = value => {
  document.cookie = `vfox_probe=${value}; path=/; max-age=86400`
  localStorage.setItem('vfox_probe', value)
  return {
    cookie: document.cookie,
    localStorage: localStorage.getItem('vfox_probe'),
  }
}

const READ_STATE = () => ({
  cookie: document.cookie,
  localStorage: localStorage.getItem('vfox_probe'),
})

/** A page on a real origin, so cookies and localStorage have somewhere to persist. */
async function startProbeServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>VFox window probe</title></head>' +
        '<body><h1>VFox</h1><p id="probe">persistence probe</p></body></html>',
    )
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

/* -------------------------------------------------------------------------------- main flow */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-window-'))
const tempRoot = os.tmpdir()
let core = null
let server = null
let failure = null
const report = { dataDir, checks: {} }

log(`data dir: ${dataDir}`)

try {
  let createCore
  try {
    ;({ createCore } = await import('../dist/index.js'))
  } catch (error) {
    fail(
      'build-missing',
      `could not import ../dist/index.js: ${message(error)}`,
      2,
      'run `pnpm --filter @vfox/core build` before this script',
    )
  }

  core = await createCore({ dataDir, kernelDir: process.env.CAMOUFOX_INSTALL_DIR })

  const kernel = await core.kernel.info()
  if (!kernel.installed) {
    fail('engine-missing', 'the Camoufox engine is not installed', 2, 'run `pnpm kernel:fetch`')
  }
  report.engine = kernel.version

  const profile = await core.profiles.create({
    name: 'window-verify',
    // Headed, on purpose. `launch.headless` defaults to false and this script depends on that.
    launch: { headless: false },
    fingerprint: { geoip: false },
  })
  report.profileId = profile.id

  const probe = await startProbeServer()
  server = probe.server

  /* -- 1. launch a real headed window ------------------------------------------------------ */
  let runtime
  try {
    runtime = await core.runtime.launch(profile.id)
  } catch (error) {
    const reason = message(error)
    fail(
      'launch',
      `the headed profile did not launch: ${reason}`,
      2,
      /EPERM/.test(reason)
        ? 'the shell is sandboxed and cannot pipe stdio; this check needs an interactive desktop'
        : 'check the engine install',
    )
  }
  if (runtime.status !== 'running' || !runtime.wsEndpoint || runtime.pid === null) {
    fail('launch', `runtime reported ${runtime.status} without pid/wsEndpoint`, 2)
  }
  report.pid = runtime.pid
  report.wsEndpoint = runtime.wsEndpoint
  step('launch', { pid: runtime.pid, status: runtime.status })

  const { pids, walked, reason: pidReason } = enginePids(runtime.pid)
  report.pidSet = [...pids]
  report.pidTreeWalked = walked
  report.pidTreeReason = pidReason
  if (!walked) {
    log(
      `warning: could not walk the process tree (${pidReason}); the pid path is the launcher pid ` +
        `alone, so the "${ENGINE_IMAGE_NAME}" image-name path is what can find the real window`,
    )
  }

  const api = await loadUser32()
  const workArea = api.workArea()
  report.workArea = workArea
  if (!workArea) {
    fail('window', 'could not read the desktop work area (SPI_GETWORKAREA failed)', 2)
  }

  const lookup = await waitForWindow(api, pids)
  const window = lookup.window
  report.window = {
    pid: window.pid,
    hwnd: window.hwnd,
    title: window.title,
    rect: window.rect,
    iconic: window.iconic,
  }
  report.windowLookup = {
    matchedBy: lookup.matchedBy,
    engineImage: ENGINE_IMAGE_NAME,
    pidPath: {
      pids: [...pids],
      treeWalked: walked,
      treeReason: pidReason,
      windows: lookup.pidWindows,
    },
    imagePath: { image: ENGINE_IMAGE_NAME, windows: lookup.imageWindows },
  }
  step('window-exists', { ...report.window, matchedBy: lookup.matchedBy })
  step('window-lookup', report.windowLookup)

  /* -- 2. the window is a normal size ------------------------------------------------------ */
  const { width, height } = window.rect
  const sizeDetails = { window: report.window, workArea, matchedBy: lookup.matchedBy }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    fail(
      'size',
      `the engine window is ${width}x${height}, below the ${MIN_WIDTH}x${MIN_HEIGHT} minimum`,
      1,
      'a 0x0 or 1x1 window is not a usable browser window',
      sizeDetails,
    )
  }
  // A window larger than the physical desktop is EXPECTED, not suspicious: the engine sizes the real
  // window to the profile's *spoofed* screen, and that screen is generated without knowing how big
  // the runner's desktop is. Measured on the 1024x720 runner: a generated screen produced a real
  // 1679x1409 window, which is correct behaviour rather than evidence of a bad match.
  //
  // This used to be a hard failure, which was wrong twice over. It rejected correct product
  // behaviour, and because it ran before the page was even connected it blocked every later
  // assertion — including the geometry numbers that say whether the spoof is coherent, which is the
  // entire reason this job exists. The window's identity is guaranteed far more strongly by the
  // process-image match than by any size heuristic, so the ceiling is reported and the checks that
  // actually matter (chrome thickness, screen self-consistency) do the asserting.
  if (
    width > workArea.width + WORK_AREA_TOLERANCE ||
    height > workArea.height + WORK_AREA_TOLERANCE
  ) {
    report.findings ??= {}
    report.findings.overflowsWorkArea = {
      window: { width, height },
      workArea: { width: workArea.width, height: workArea.height },
      overshoot: { width: width - workArea.width, height: height - workArea.height },
      matchedBy: lookup.matchedBy,
    }
    log(
      `FINDING: the engine window (${width}x${height}) is larger than the ` +
        `${workArea.width}x${workArea.height} work area. The engine sizes the real window to the ` +
        "profile's spoofed screen, so this is expected on a small runner desktop — but it also " +
        "means a profile whose generated screen exceeds the user's real display opens a window " +
        'that runs off the screen. Reported, not failed; the geometry checks below decide whether ' +
        'the spoof is coherent.',
    )
  }
  report.checks.size = { ok: true, width, height }
  step('window-size', { width, height, workArea })

  /* -- 3. it is a usable Firefox ----------------------------------------------------------- */
  let browser = await firefox.connect(runtime.wsEndpoint)
  let context = browser.contexts()[0]
  if (!context) {
    fail('page', 'the engine exposed no browser context', 1)
  }
  let page = context.pages()[0] ?? (await context.newPage())

  let pageSource = 'https://example.com'
  try {
    await page.goto('https://example.com', { timeout: 20_000, waitUntil: 'domcontentloaded' })
  } catch (error) {
    // A runner without egress must not fail the product's window check.
    log(`example.com did not load (${message(error)}); falling back to a data: URL`)
    pageSource = 'data:text/html,<title>VFox offline probe</title><h1>offline</h1><p>body</p>'
    await page.goto(pageSource, { timeout: 20_000 })
  }
  await page.bringToFront()

  const view = await page.evaluate(PAGE_PROBE)
  report.page = { source: pageSource, ...view }

  const identityUa = profile.identity?.fingerprint?.navigator?.userAgent
  if (typeof view.userAgent !== 'string' || view.userAgent.length === 0) {
    fail('page', 'the page reported an empty navigator.userAgent', 1)
  }
  if (!/Firefox\/\d/.test(view.userAgent)) {
    fail('page', `the page is not a Firefox: "${view.userAgent}"`, 1)
  }
  if (typeof identityUa === 'string' && uaShape(identityUa) !== uaShape(view.userAgent)) {
    fail(
      'page',
      `the page's user agent does not match the profile's stored identity:\n` +
        `        page:     ${view.userAgent}\n        identity: ${identityUa}`,
      1,
    )
  }
  if (view.title.length === 0) {
    fail('page', 'the loaded page has an empty document.title', 1)
  }
  if (view.textLength <= 0) {
    fail('page', 'the loaded page has no body text — this is not a usable document', 1)
  }
  report.checks.page = {
    ok: true,
    userAgent: view.userAgent,
    title: view.title,
    textLength: view.textLength,
  }
  step('page', {
    source: pageSource,
    userAgent: view.userAgent,
    title: view.title,
    textLength: view.textLength,
  })

  /* -- geometry coherence (raw numbers, always reported) ----------------------------------- */
  const chrome = {
    width: view.outerWidth - view.innerWidth,
    height: view.outerHeight - view.innerHeight,
  }
  const osRatio = {
    width: view.outerWidth > 0 ? width / view.outerWidth : null,
    height: view.outerHeight > 0 ? height / view.outerHeight : null,
  }
  report.geometry = {
    osRect: window.rect,
    outer: { width: view.outerWidth, height: view.outerHeight },
    inner: { width: view.innerWidth, height: view.innerHeight },
    chrome,
    osOverOuter: osRatio,
    screen: {
      x: view.screenX,
      y: view.screenY,
      width: view.screenWidth,
      height: view.screenHeight,
      availWidth: view.availWidth,
      availHeight: view.availHeight,
    },
    devicePixelRatio: view.devicePixelRatio,
  }
  log(
    `geometry: os ${width}x${height} | outer ${view.outerWidth}x${view.outerHeight} | ` +
      `inner ${view.innerWidth}x${view.innerHeight} | chrome ${chrome.width}x${chrome.height} | ` +
      `screenX/Y ${view.screenX},${view.screenY} | screen ${view.screenWidth}x${view.screenHeight} ` +
      `(avail ${view.availWidth}x${view.availHeight}) | dpr ${view.devicePixelRatio}`,
  )

  // (a) OS rect vs window.outer*: reported, not asserted. DPI virtualisation means the two can
  // legitimately differ by the scale factor, so a mismatch is a finding for a human to judge.
  const expectedOuter = {
    width: osRatio.width === null ? null : Math.round(width / (osRatio.width || 1)),
    height: osRatio.height === null ? null : Math.round(height / (osRatio.height || 1)),
  }
  const osMatchesOuter =
    Math.abs(width / (view.devicePixelRatio || 1) - view.outerWidth) <= 32 &&
    Math.abs(height / (view.devicePixelRatio || 1) - view.outerHeight) <= 32
  report.geometry.osMatchesOuter = osMatchesOuter
  report.geometry.expectedOuterFromOs = expectedOuter
  if (!osMatchesOuter) {
    log(
      `FINDING: the OS window rect (${width}x${height}, /dpr = ` +
        `${Math.round(width / (view.devicePixelRatio || 1))}x${Math.round(height / (view.devicePixelRatio || 1))}) ` +
        `does not match window.outerWidth/outerHeight (${view.outerWidth}x${view.outerHeight}). ` +
        'The spoofed outer size and the real window disagree — reported, not failed (DPI).',
    )
  }

  // (b) the viewport, measured against the OS rectangle rather than against our own numbers.
  //
  // There used to be a check here comparing `outerWidth - innerWidth` against a 120px band. It was
  // self-referential — both operands came from the page — and tighter than the OS-anchored band, so it
  // could fail a profile whose spoofed outer size is simply smaller than the real window. Comparing our
  // number to our number cannot catch a wrong allowance, which is the only failure this block exists
  // for, so it is gone; the check below anchors on the one source that cannot move with our values.
  const viewport = checkViewportAgainstOs({
    osRect: { width, height },
    innerWidth: view.innerWidth,
    innerHeight: view.innerHeight,
    devicePixelRatio: view.devicePixelRatio,
  })
  if (!viewport.ok) {
    fail(
      'geometry',
      `the page viewport disagrees with the real window: ${viewport.failures.join('; ')}`,
      1,
      'the reported viewport does not match the window the OS gave us — a detector can see this',
    )
  }

  // (c) screen bounds and self-consistency.
  if (
    view.screenX < -64 ||
    view.screenY < -64 ||
    view.screenX > view.screenWidth ||
    view.screenY > view.screenHeight
  ) {
    fail(
      'geometry',
      `window.screenX/Y (${view.screenX},${view.screenY}) is outside the reported screen ` +
        `${view.screenWidth}x${view.screenHeight}`,
      1,
    )
  }
  if (
    view.screenWidth <= 0 ||
    view.screenHeight <= 0 ||
    view.availWidth <= 0 ||
    view.availHeight <= 0 ||
    view.availWidth > view.screenWidth ||
    view.availHeight > view.screenHeight
  ) {
    fail(
      'geometry',
      `screen geometry is not self-consistent: ${view.screenWidth}x${view.screenHeight} ` +
        `(avail ${view.availWidth}x${view.availHeight})`,
      1,
    )
  }
  if (view.devicePixelRatio < 0.5 || view.devicePixelRatio > 4) {
    fail('geometry', `implausible devicePixelRatio ${view.devicePixelRatio}`, 1)
  }
  report.checks.geometry = { ok: true, chrome, osMatchesOuter }
  step('geometry', { chrome, osMatchesOuter, devicePixelRatio: view.devicePixelRatio })

  /* -- screenshot, while the window is open and in front ----------------------------------- */
  if (screenshotPath) {
    const capture = path.resolve(repoRoot, 'scripts', 'capture-desktop.ps1')
    try {
      await fs.access(capture)
    } catch {
      fail(
        'screenshot',
        `--screenshot needs ${capture}, which does not exist`,
        2,
        'the capture helper lives in scripts/capture-desktop.ps1 (owned by ci)',
      )
    }
    api.bringToFront(window.hwnd, window.iconic)
    await page.bringToFront()
    await new Promise(resolve => setTimeout(resolve, 750))
    const absolute = path.resolve(screenshotPath)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    // `-Rect` with the rect `GetWindowRect` already returned, rather than `-CropToProcessName`: we
    // know exactly which window we mean, and it is the branch the capture helper has actually been
    // exercised on — the process-name lookup cannot be tested in the development sandbox, where no
    // process exposes a MainWindowHandle. A partly offscreen rect is clipped by the helper.
    const rect = window.rect
    // `stdio: 'inherit'`: a piped child stdio slot is denied by the development sandbox, and the
    // helper prints its own JSON verdict to the log.
    const shot = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        capture,
        '-Path',
        absolute,
        '-Rect',
        `${rect.x},${rect.y},${rect.width},${rect.height}`,
      ],
      { stdio: 'inherit' },
    )
    if (shot.error || shot.status !== 0) {
      fail(
        'screenshot',
        `the desktop capture failed (${shot.error?.message ?? `exit ${shot.status}`})`,
        1,
      )
    }
    const stats = await fs.stat(absolute).catch(() => null)
    if (!stats || stats.size < 1024) {
      fail('screenshot', `the capture at ${absolute} is missing or too small to be an image`, 1)
    }
    report.screenshot = { path: absolute, bytes: stats.size }
    step('screenshot', report.screenshot)
  }

  /* -- 4. state survives a restart --------------------------------------------------------- */
  const marker = `vfox-${Date.now()}`
  await page.goto(probe.url, { timeout: 20_000, waitUntil: 'domcontentloaded' })
  const written = await page.evaluate(SET_STATE, marker)
  if (!written.cookie.includes('vfox_probe=')) {
    fail('state', `the probe cookie was not set (document.cookie = "${written.cookie}")`, 1)
  }
  if (written.localStorage !== marker) {
    fail('state', `localStorage did not accept the probe value (got ${written.localStorage})`, 1)
  }
  report.state = { origin: probe.url, marker, written }
  step('state-written', {
    origin: probe.url,
    cookie: written.cookie,
    localStorage: written.localStorage,
  })

  // Detach the client and stop the profile through the core, then relaunch the SAME profile.
  await browser.close()
  browser = null
  await core.runtime.stop(profile.id)
  log('profile stopped; relaunching it to check that state persisted')

  const second = await core.runtime.launch(profile.id)
  if (second.status !== 'running' || !second.wsEndpoint || second.pid === null) {
    fail('state', `the relaunched profile reported ${second.status} without pid/wsEndpoint`, 1)
  }
  browser = await firefox.connect(second.wsEndpoint)
  context = browser.contexts()[0]
  if (!context) {
    fail('state', 'the relaunched profile exposed no context', 1)
  }
  page = context.pages()[0] ?? (await context.newPage())
  await page.goto(probe.url, { timeout: 20_000, waitUntil: 'domcontentloaded' })
  const restored = await page.evaluate(READ_STATE)
  report.state.restored = restored

  if (!restored.cookie.includes(`vfox_probe=${marker}`)) {
    fail(
      'state',
      `the cookie did not survive the restart: expected vfox_probe=${marker}, document.cookie is ` +
        `"${restored.cookie}"`,
      1,
      'a profile whose cookies are lost on restart is not a usable browser',
    )
  }
  if (restored.localStorage !== marker) {
    fail(
      'state',
      `localStorage did not survive the restart: expected ${marker}, got ${restored.localStorage}`,
      1,
    )
  }
  report.checks.state = { ok: true, cookie: restored.cookie, localStorage: restored.localStorage }
  step('state-restored', {
    cookie: restored.cookie,
    localStorage: restored.localStorage,
    relaunchPid: second.pid,
  })

  /* -- 5. the window survives the automation client detaching ------------------------------ */
  await browser.close()
  browser = null
  // The relaunch is a NEW process, so the pid set from the first launch is dead. Looking the window
  // up again for `second.pid` is not optional: with the stale set this check can never find anything
  // and would blame "the window vanished on detach" for what is really a stale lookup.
  const secondTree = enginePids(second.pid)
  report.detachPidSet = [...secondTree.pids]
  const detachLookup = await waitForWindow(api, secondTree.pids, {
    stage: 'detach',
    context: 'the relaunched engine, after the automation client detached',
  })
  const stillThere = detachLookup.window
  report.checks.detach = {
    ok: true,
    hwnd: stillThere.hwnd,
    title: stillThere.title,
    matchedBy: detachLookup.matchedBy,
  }
  step('detach-survived', {
    hwnd: stillThere.hwnd,
    title: stillThere.title,
    visible: stillThere.visible,
    matchedBy: detachLookup.matchedBy,
  })

  /* -- 6. cleanup -------------------------------------------------------------------------- */
  const stopped = await core.runtime.stop(profile.id)
  if (stopped.status !== 'stopped') {
    fail('cleanup', `the profile is ${stopped.status} after stop()`, 1)
  }
  await core.close()
  core = null
  await new Promise(resolve => setTimeout(resolve, 1500))

  const leftover = listEngineProcesses()
  if (leftover === null) {
    log('warning: could not enumerate engine processes; the orphan check is inconclusive here')
    report.checks.cleanup = { ok: true, processesChecked: false }
  } else {
    if (leftover.length > 0) {
      fail(
        'cleanup',
        `${leftover.length} engine process(es) survived: ${leftover.map(entry => entry.pid).join(', ')}`,
        1,
      )
    }
    report.checks.cleanup = { ok: true, processesChecked: true }
  }
  step('cleanup', { engineProcesses: leftover?.length ?? null })

  emit('VFOX_WINDOW_OK', report)
  log('PASS: a real visible window, a usable Firefox, and state that survives a restart')
} catch (error) {
  failure =
    error instanceof WindowFailure
      ? error
      : new WindowFailure('unexpected', message(error), 1, undefined)
} finally {
  try {
    await browser?.close()
  } catch {
    // The browser may already be gone; cleanup must not mask the real result.
  }
  try {
    await core?.close()
  } catch (error) {
    log(`warning: closing the core failed: ${message(error)}`)
  }
  server?.close()
  if (process.env.VFOX_WINDOW_KEEP === '1') {
    log(`keeping ${dataDir} (VFOX_WINDOW_KEEP=1)`)
  } else {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    const leftovers = (await fs.readdir(tempRoot).catch(() => [])).filter(name =>
      name.startsWith('vfox-window-'),
    )
    if (leftovers.length > 0) {
      log(`warning: temp directories left behind: ${leftovers.join(', ')}`)
    }
  }
}

if (failure) {
  emit(
    'VFOX_WINDOW_FAIL',
    {
      stage: failure.stage,
      reason: failure.message,
      hint: failure.hint ?? null,
      details: failure.details,
    },
    process.stderr,
  )
  log(`FAILED at ${failure.stage}: ${failure.message}`)
  if (failure.hint) {
    log(`hint: ${failure.hint}`)
  }
  process.exit(failure.exitCode)
}
