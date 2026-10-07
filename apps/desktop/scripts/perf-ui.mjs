/**
 * A performance guard for the profile table, measured on the REAL built renderer.
 *
 * Why it exists: the owner reported the app as "not slow to start - sluggish in use", and nothing in
 * this repository could turn that into a number. A feeling cannot be reviewed, cannot regress-test and
 * cannot be argued with; a measurement can. This runs the same way `screenshot-ui.mjs` does - the built
 * renderer served over loopback, driven by headless Chromium, talking to the real `@vfox/server` over
 * the real HTTP/SSE contract - and reports what the main thread actually did.
 *
 * WHAT IT MEASURES
 *   - long tasks (`PerformanceObserver` type `longtask`): any block over 50 ms, which is the unit of
 *     "the interface stopped responding".
 *   - total blocking time: the sum of the over-50 ms parts, the standard jank metric.
 *   - event-to-DOM latency: how long after the server reports a runtime change the row shows it.
 *
 * WHAT IT DOES NOT PROVE, and says so in its own output: that the app feels smooth on a real desktop
 * with a real GPU and real profiles. It is a regression detector with generous budgets, not a promise.
 * A green run means "no measurement here is bad", never "the product is fast".
 *
 * Usage:
 *   pnpm --filter @vfox/desktop build
 *   node scripts/perf-ui.mjs
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '@vfox/server'
import { API_ROUTES, API_TOKEN_HEADER } from '@vfox/shared'
import { createStaticServer } from './static-server.mjs'
import { assertBridgeParses, bridgeData, installBridge } from './ui-bridge.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..')
const rendererDir = join(appRoot, 'out', 'renderer')
const dataDir = join(appRoot, '.cache', 'tmp', `ui-perf-${process.pid}`)

/** Enough rows that a per-row cost is visible, few enough that CI stays quick. */
const PROFILE_COUNT = 40
/** Budgets. Generous on purpose: this catches a stall, not a 5 ms difference. */
const MAX_LONG_TASK_MS = 250
const MAX_TOTAL_BLOCKING_MS = 1500
const MAX_EVENT_TO_DOM_MS = 3000

if (!existsSync(join(rendererDir, 'index.html'))) {
  console.error(`No built renderer at ${rendererDir}. Run: pnpm --filter @vfox/desktop build`)
  process.exit(2)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error(
    'playwright is not installed. Run: pnpm install, then: npx playwright install chromium',
  )
  process.exit(2)
}
if (!existsSync(chromium.executablePath())) {
  console.error(
    `Chromium is not installed for Playwright (expected at ${chromium.executablePath()})`,
  )
  process.exit(2)
}

/** Every problem found, printed together at the end so one run reports everything. */
const failures = []
const measurements = []

function record(name, value, budget) {
  measurements.push({ name, value, budget })
  if (budget !== null && value > budget) {
    failures.push(`${name}: ${value} exceeds the budget of ${budget}`)
  }
}

assertBridgeParses(
  bridgeData({
    apiBase: 'http://127.0.0.1:1',
    token: 'x',
    version: '0.0.0',
    platform: 'win32',
    dataDir: appRoot,
    dataMode: 'custom',
    serviceError: null,
  }),
  'self-check',
)

await rm(dataDir, { recursive: true, force: true })
await mkdir(dataDir, { recursive: true })

const api = await startServer({ dataDir, port: 0 })
const staticServer = createStaticServer(rendererDir)
await new Promise((done, fail) => {
  staticServer.once('error', fail)
  staticServer.listen(0, '127.0.0.1', done)
})
const address = staticServer.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

const call = async (path, init = {}) => {
  const response = await fetch(`${api.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      [API_TOKEN_HEADER]: api.token,
      ...(init.headers ?? {}),
    },
  })
  return response.json()
}

// Fill the table through the product's own API, one create at a time - the same call the dialog makes.
for (let index = 0; index < PROFILE_COUNT; index += 1) {
  await call(API_ROUTES.profiles, {
    method: 'POST',
    body: JSON.stringify({ name: `perf-${String(index).padStart(3, '0')}` }),
  })
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
// `startServer` returns `url`; the bridge wants `apiBase`. Spreading the server object gave the
// renderer an undefined `apiBase`, so it could not reach its own API and the only symptom was the
// table never appearing - the 30 s selector timeout that ui-bridge.mjs warns about in its own header.
await page.addInitScript(
  installBridge,
  bridgeData({
    apiBase: api.url,
    token: api.token,
    version: '0.0.0-perf',
    platform: process.platform,
    dataDir,
    dataMode: 'custom',
    serviceError: null,
  }),
)

// Installed before the app boots, so nothing that happens during startup is missed.
await page.addInitScript(() => {
  window.__vfoxPerf = { longTasks: [], blocking: 0 }
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__vfoxPerf.longTasks.push(entry.duration)
        if (entry.duration > 50) window.__vfoxPerf.blocking += entry.duration - 50
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    window.__vfoxPerf.unsupported = true
  }
})

await page.goto(baseUrl, { waitUntil: 'load' })

// Assert the bridge is there BEFORE waiting on anything it enables. Without this, a mistake in the
// bridge data is indistinguishable from a slow renderer until the selector times out 30 s later.
// The renderer reaches its API with apiBase + token over plain fetch. There is no window.vfox.api -
// the interface, the real preload and ui-bridge.mjs all agree - so an earlier version of this
// preflight failed while printing a perfectly good apiBase in the same message.
const bridge = await page.evaluate(() => ({
  apiBase: typeof window.vfox?.apiBase === 'string' ? window.vfox.apiBase : null,
  hasToken: typeof window.vfox?.token === 'string' && window.vfox.token.length > 0,
}))
if (!bridge.apiBase || !bridge.hasToken) {
  console.error(
    'perf-ui: the renderer has no working bridge (apiBase=' +
      String(bridge.apiBase) +
      ', token=' +
      String(bridge.hasToken) +
      '). The page cannot reach its own API, so nothing will render. Check the bridgeData fields.',
  )
  await browser.close()
  await new Promise(done => staticServer.close(done))
  await api.close()
  process.exit(1)
}

await page.locator('.el-table__row').first().waitFor({ timeout: 30_000 })
const rows = await page.locator('.el-table__row').count()

console.log(`perf-ui: ${rows} rows in the table`)

/**
 * Read the counters and start a new window, so a long task can be attributed to the phase that caused it.
 *
 * The first run of this guard reported a 432 ms block and could not say where it came from - our render
 * path, or headless Chromium with no GPU. Those need different responses, and widening the budget until
 * the question disappeared would have been weakening the guard rather than answering it.
 */
async function takeWindow(label) {
  const snapshot = await page.evaluate(() => {
    const tasks = window.__vfoxPerf.longTasks
    const blocking = window.__vfoxPerf.blocking
    window.__vfoxPerf.longTasks = []
    window.__vfoxPerf.blocking = 0
    return { tasks, blocking }
  })
  const longest = snapshot.tasks.length > 0 ? Math.max(...snapshot.tasks) : 0
  return {
    label,
    longest: Math.round(longest),
    blocking: Math.round(snapshot.blocking),
    count: snapshot.tasks.length,
  }
}
if (rows < PROFILE_COUNT) {
  failures.push(`expected at least ${PROFILE_COUNT} rows, found ${rows}`)
}

// Reset the counters: startup work is not what this measures.
await page.evaluate(() => {
  window.__vfoxPerf.longTasks = []
  window.__vfoxPerf.blocking = 0
})

/* ---------------------------------------------------------- A. filtering the table */

const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
if ((await search.count()) > 0) {
  const started = Date.now()
  await search.fill('perf-01')
  await page.locator('.el-table__row').first().waitFor({ timeout: 15_000 })
  const filterMs = Date.now() - started
  record('filter a 40-row table (ms) [reported, not asserted]', filterMs, null)
  await search.fill('')
  await page.locator('.el-table__row').first().waitFor({ timeout: 15_000 })
} else {
  failures.push('no search box found, so the filter measurement did not run')
}

// What did the filter window cost?
const filterWindow = await takeWindow('filtering')
record(
  `longest long task while filtering (ms) [${filterWindow.count} task(s)]`,
  filterWindow.longest,
  null,
)
record('blocking time while filtering (ms)', filterWindow.blocking, null)

/* ------------------------------------------- B. event-to-DOM latency, through the real SSE stream */

/**
 * Measure a transition that ACTUALLY CHANGES the row.
 *
 * The first version of this stopped an already-stopped profile and waited for `.status.stopped`. The
 * server does push an event for that - the registry emits on every set - but the row was ALREADY
 * showing stopped, so the selector matched instantly, the number was always about zero and the check
 * could not fail. That is the class of defect this repository keeps rediscovering, so the measurement
 * now uses a launch (stopped -> starting -> error, which spawns nothing when no engine is installed),
 * refuses to count a wait that was already satisfied, and skips itself loudly if an engine IS present,
 * because then a launch would start a real browser.
 */
const kernel = await call(API_ROUTES.kernel).catch(() => null)
const engineInstalled = Boolean(kernel?.data?.installed)

if (engineInstalled) {
  measurements.push({
    name: 'request to DOM, launch transition (ms)',
    value: 'SKIPPED',
    budget: null,
  })
  failures.push(
    'an engine is installed in this job, so the launch transition could not be measured without ' +
      'starting a real browser - the measurement is SKIPPED, not passed',
  )
} else {
  // The row is found by the NAME this script created, and the id comes from the API where ids live.
  // Element Plus renders rows with no data attributes at all - row-key is the Vue key, internal
  // identity rather than DOM state - so an earlier version looked for data-row-key, never found it,
  // and could not run. Verified against element-plus's own render code and a grep of the package.
  const watched = 'perf-000'
  const listed = await call(API_ROUTES.profiles)
  const watchedProfile = (listed?.data ?? []).find(entry => entry.name === watched)
  const rowSelector = `.el-table__row:has-text("${watched}")`

  if (!watchedProfile?.id) {
    failures.push(
      `the API did not return the profile named ${watched}, so the measurement could not run`,
    )
  } else if ((await page.locator(rowSelector).count()) === 0) {
    failures.push(`no table row shows ${watched}, so the measurement could not run`)
  } else {
    const before = await page.locator(`${rowSelector} .status`).first().getAttribute('class')
    const started = Date.now()
    await call(API_ROUTES.launchProfile(watchedProfile.id), { method: 'POST', body: '{}' })
    let sawError = true
    try {
      await page.locator(`${rowSelector} .status.error`).waitFor({ timeout: 15_000 })
    } catch {
      sawError = false
    }
    const elapsed = Date.now() - started
    const after = await page.locator(`${rowSelector} .status`).first().getAttribute('class')

    if (!sawError) {
      // A timeout is its own failure with its own message. Swallowing it and recording 15000
      // reported a stall as though it were a slow update, which is a measurement meaning nothing.
      failures.push(
        'the row never showed error within 15s of the launch request - the renderer did not react at all',
      )
    } else if ((before ?? '').includes('error') && before === after) {
      failures.push(
        'the measurement waited for a state the row was already in - it measured nothing',
      )
    } else {
      record('request to DOM, launch transition (ms)', elapsed, MAX_EVENT_TO_DOM_MS)
    }
  }
}

/* ------------------------------------------------------------------------ the verdict */

// What did the event-to-DOM window cost? This is the one that decides whether the earlier 432 ms block
// belongs to a phase we can act on or to the environment.
const eventWindow = await takeWindow('event to DOM')

const perf = await page.evaluate(() => ({
  longTasks: window.__vfoxPerf.longTasks,
  blocking: window.__vfoxPerf.blocking,
  unsupported: Boolean(window.__vfoxPerf.unsupported),
}))

if (perf.unsupported) {
  console.log(
    'perf-ui: this Chromium does not support the longtask observer - only the other numbers count',
  )
} else {
  const longest = perf.longTasks.length > 0 ? Math.max(...perf.longTasks) : 0
  record(
    `longest long task after both phases (ms) [${perf.longTasks.length} task(s)]`,
    Math.round(longest),
    null,
  )
  // The assertion lands on the event-to-DOM window, which is the interactive path: a block there is a
  // block while the user is waiting for the table to answer. The filtering window is reported but not
  // asserted, because typing into a box and re-rendering 40 rows is a bulk operation and its cost is
  // worth watching rather than failing on until there is a distribution to judge it against.
  record(
    `longest long task, event-to-DOM window (ms) [${eventWindow.count} task(s)]`,
    eventWindow.longest,
    MAX_LONG_TASK_MS,
  )
  record('blocking time, event-to-DOM window (ms)', eventWindow.blocking, MAX_TOTAL_BLOCKING_MS)
  record('total blocking time (ms)', Math.round(perf.blocking), MAX_TOTAL_BLOCKING_MS)
  record('long tasks over 50 ms (count)', perf.longTasks.length, null)
}

console.log('')
console.log('perf-ui measurements:')
for (const entry of measurements) {
  const budget = entry.budget === null ? '' : `  (budget ${entry.budget})`
  console.log(`  ${entry.name.padEnd(42)} ${String(entry.value).padStart(7)}${budget}`)
}
const measured = measurements.filter(entry => typeof entry.value === 'number').length
console.log('')
console.log(
  `perf-ui produced ${String(measured)} real measurement(s); anything not listed as a number did not ` +
    'run and must not be read as a pass.',
)
console.log(
  'perf-ui does NOT prove the app feels smooth: no GPU, no real profiles, one machine. It is a\n' +
    'regression detector with generous budgets. A green run means no measurement here is bad.',
)

await browser.close()
await new Promise(done => staticServer.close(done))
await api.close()
await rm(dataDir, { recursive: true, force: true }).catch(() => {})

if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  process.exit(1)
}
console.log('OK - every measurement is inside its budget')
