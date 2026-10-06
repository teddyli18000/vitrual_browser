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
await page.addInitScript(installBridge, bridgeData({ ...api, dataDir, dataMode: 'custom' }))

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
await page.locator('.el-table__row').first().waitFor({ timeout: 30_000 })
const rows = await page.locator('.el-table__row').count()

console.log(`perf-ui: ${rows} rows in the table`)
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
  record('filter a 40-row table (ms)', filterMs, null)
  await search.fill('')
  await page.locator('.el-table__row').first().waitFor({ timeout: 15_000 })
} else {
  failures.push('no search box found, so the filter measurement did not run')
}

/* ------------------------------------------- B. event-to-DOM latency, through the real SSE stream */

/**
 * Stop a profile that is already stopped. It is a real transition on the server (`stopping`/`stopped`
 * are pushed like any other), it spawns no browser, and it needs no engine - which is what makes this
 * measurable in a job that has neither.
 */
const firstRow = page.locator('.el-table__row').first()
const profileId = await firstRow.getAttribute('data-row-key').catch(() => null)

if (profileId) {
  const started = Date.now()
  await call(API_ROUTES.stopProfile.replace(':id', profileId), { method: 'POST', body: '{}' })
  await page
    .locator(`.el-table__row[data-row-key="${profileId}"] .status.stopped`)
    .waitFor({ timeout: 15_000 })
    .catch(() => {})
  record('event to DOM, stop transition (ms)', Date.now() - started, MAX_EVENT_TO_DOM_MS)
} else {
  console.log(
    'perf-ui: the table exposes no data-row-key, so the event-to-DOM measurement was skipped',
  )
}

/* ------------------------------------------------------------------------ the verdict */

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
  record('longest long task (ms)', Math.round(longest), MAX_LONG_TASK_MS)
  record('total blocking time (ms)', Math.round(perf.blocking), MAX_TOTAL_BLOCKING_MS)
  record('long tasks over 50 ms (count)', perf.longTasks.length, null)
}

console.log('')
console.log('perf-ui measurements:')
for (const entry of measurements) {
  const budget = entry.budget === null ? '' : `  (budget ${entry.budget})`
  console.log(`  ${entry.name.padEnd(42)} ${String(entry.value).padStart(7)}${budget}`)
}
console.log('')
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
