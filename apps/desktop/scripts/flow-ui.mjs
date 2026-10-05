/**
 * Drives the **real renderer** through the primary workflow, against the **real server**.
 *
 * Why this exists, and why the screenshots are not enough: `screenshot-ui.mjs` photographs states but
 * never clicks anything that matters, so a handler that stopped firing, a store that stopped
 * updating, or a click that paints optimistically while the server disagrees all still produce a
 * perfect screenshot of the state *before* the click. And the server suite cannot cover it either —
 * it drives a fake Core, so a broken SSE route passed there because `runtime.list()` answered
 * synchronously and Fastify never lost the race. Wiring is only observable in a browser talking to
 * the real thing.
 *
 * What it proves, in order:
 *   1. **Create** through the dialog: the row appears *and* `GET /api/v1/profiles` contains it.
 *      The renderer saying so is not evidence the server did.
 *   2. **Launch**: the row's status leaves `stopped` **and the server reports the same status**. The
 *      runtime store is written only by the SSE handler, so a DOM that catches up with the server can
 *      only have learned it from the push — an optimistic paint would show a status the server does
 *      not have, and a dead stream would leave the row on `stopped` while the server moved on.
 *   3. **Stop**: the row returns to `stopped` and the server agrees.
 *   4. **Reload**: the profile is still there and still stopped — the check that catches state living
 *      only in renderer memory, which this project has done before.
 *
 * It asserts *agreement with the server*, never a hardcoded status. That is deliberate: whether the
 * launch ends in `running` or `error` depends on whether an engine is installed, and this harness
 * refuses to let an engine near it (see below), so on CI the honest terminal state is `error`. The
 * assertion is strictly stronger than `=== 'running'`, because it also fails when the renderer
 * invents a state the server never reported.
 *
 *   pnpm --filter @vfox/desktop build
 *   node scripts/flow-ui.mjs
 *
 * TWO things make this hermetic, and both are load-bearing:
 *
 *  - `CAMOUFOX_INSTALL_DIR` is pointed at an empty directory **before** `@vfox/server` is imported,
 *    so no engine can be found and no browser window can ever open. Hence the dynamic import below,
 *    not a static one: ESM hoists static imports above the module body, so a static import would let
 *    camoufox-js capture the ambient value at its own load time — the mismatch that made a probe of
 *    mine behave inexplicably.
 *  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, because **launching a profile with no engine silently
 *    downloads camoufox-js's own 1.31 GB browser copy.** Without this the test downloads it into
 *    whatever cache camoufox-js defaults to — measured, not theorised: it put 2,459 MB inside a
 *    `.cache/tmp/` directory here before anyone noticed.
 *
 * `VFOX_FLOW_BREAK=sse` neuters the renderer's event stream on purpose. It exists so the harness can
 * be shown to discriminate rather than merely to pass: with the stream dead the DOM stays on `已停止`
 * while the server moves to `异常`, step 2 fails, and the message names both. See the README note in
 * `AGENTS.md` — a guard that has only ever been green is worse than no guard.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, API_TOKEN_HEADER } from '@vfox/shared'
import { waitForAgreement } from './flow-assert.mjs'
import { createStaticServer } from './static-server.mjs'
import { assertBridgeParses, bridgeData, installBridge } from './ui-bridge.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..')
const rendererDir = join(appRoot, 'out', 'renderer')
const dataDir = join(appRoot, '.cache', 'tmp', `ui-flow-${process.pid}`)
/** An empty directory that looks like an engine root, so `kernel.installed` is false. */
const noEngineDir = join(appRoot, '.cache', 'tmp', `no-engine-${process.pid}`)

const STATUSES = ['stopped', 'starting', 'running', 'stopping', 'error']
const profileName = `流程测试 ${Date.now()}`
const sabotage = process.env.VFOX_FLOW_BREAK ?? ''

if (!existsSync(join(rendererDir, 'index.html'))) {
  console.error(`No built renderer at ${rendererDir}. Run: pnpm --filter @vfox/desktop build`)
  process.exit(2)
}

// Before the server is imported, and therefore before camoufox-js resolves its install directory.
process.env.CAMOUFOX_INSTALL_DIR = noEngineDir
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
await mkdir(noEngineDir, { recursive: true })

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error(
    'playwright is not installed. Run: pnpm install, then: npx playwright install chromium',
  )
  process.exit(2)
}
const browserPath = chromium.executablePath()
if (!existsSync(browserPath)) {
  console.error(
    `Chromium is not installed for Playwright (expected at ${browserPath}).\n` +
      'Run: npx playwright install chromium',
  )
  process.exit(2)
}

const { startServer } = await import('@vfox/server')

/* --------------------------------------------------------------------------- helpers */

let token = ''
async function api(path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { 'content-type': 'application/json', [API_TOKEN_HEADER]: token },
  })
  const body = await response.json().catch(() => null)
  if (body && body.success === false) {
    throw new Error(`GET ${path} failed: ${body.error?.code} ${body.error?.message}`)
  }
  return body?.data
}

/** The status the renderer is *showing*, read from the dot's own class rather than its text. */
async function domStatus(row) {
  const className = (await row.locator('.status').first().getAttribute('class')) ?? ''
  return className.split(/\s+/).find(part => STATUSES.includes(part)) ?? 'unknown'
}

async function domStatusText(row) {
  return (await row.locator('.status .text').first().textContent())?.trim() ?? ''
}

/**
 * Waits for the row to agree with the server. The readers are injected, and the assertion itself
 * lives in `flow-assert.mjs`, so the two failure modes this harness exists for — a renderer showing
 * a status the server does not have, and a renderer that never received the pushed one — are
 * exercised from Node without a browser. See the note at the top of that file.
 */
async function waitForRowStatus(row, expected, what, profileId, timeoutMs = 60_000) {
  return waitForAgreement({
    expected,
    what,
    timeoutMs,
    note: sabotage ? `VFOX_FLOW_BREAK=${sabotage} is set` : '',
    readDom: async () => ({ status: await domStatus(row), text: await domStatusText(row) }),
    readServer: () => api(API_ROUTES.runtimeFor(profileId)),
  })
}

function step(message) {
  console.log(`\n--- ${message}`)
}

/* ------------------------------------------------------------------------------- run */

const server = await startServer({ dataDir, port: 0 })
const apiBase = server.url
token = server.token

const staticServer = createStaticServer(rendererDir)
await new Promise((done, fail) => {
  staticServer.once('error', fail)
  staticServer.listen(0, '127.0.0.1', done)
})
const pageUrl = `http://127.0.0.1:${staticServer.address().port}`

const bridge = bridgeData({
  apiBase,
  token,
  version: '0.0.0',
  platform: 'linux',
  dataDir,
  dataMode: 'custom',
  serviceError: null,
})
assertBridgeParses(bridge, 'flow')

console.log(`api      ${apiBase}`)
console.log(`renderer ${pageUrl}`)
console.log(`profile  ${profileName}`)
console.log(`kernel   ${JSON.stringify(await api(API_ROUTES.kernel))}`)
if (sabotage) console.log(`SABOTAGE ${sabotage} — this run is expected to FAIL`)

const browser = await chromium.launch({ args: process.env.CI ? ['--no-sandbox'] : [] })
let context = null
let failure = null

try {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', error => console.error(`  [page error] ${error.message}`))
  await page.addInitScript(installBridge, bridge)
  if (sabotage === 'sse') {
    // Kill the event stream without breaking anything else. The renderer reads it with fetch +
    // ReadableStream, so a fetch that never settles is enough: no events, no error, no retry.
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url ?? '')
        if (url.includes('/api/v1/events')) return new Promise(() => {})
        return realFetch(input, init)
      }
    })
  }
  await page.goto(pageUrl, { waitUntil: 'load' })

  /* 1 — create through the dialog */
  step('create a profile through the dialog')
  await page.locator('.toolbar .el-button', { hasText: '新建环境' }).first().click()
  const dialog = page.locator('.el-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  const nameInput = dialog.locator('label.field', { hasText: '名称' }).first().locator('input')
  await nameInput.fill(profileName)
  await dialog.locator('.el-dialog__footer .el-button', { hasText: '保存' }).first().click()
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })

  const row = page.locator('.el-table__row', { hasText: profileName }).first()
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  console.log(`  renderer shows the row "${profileName}"`)

  const fromServer = (await api(API_ROUTES.profiles)).find(item => item.name === profileName)
  if (!fromServer) {
    throw new Error(
      `the renderer shows "${profileName}" but GET /api/v1/profiles does not contain it`,
    )
  }
  console.log(`  server agrees  : id=${fromServer.id} humanize=${fromServer.fingerprint.humanize}`)

  /* 2 — launch, and wait for the state the server pushes */
  step('launch it, and watch the row follow the server')
  const launchButton = row.getByRole('button', { name: '启动', exact: true })
  await launchButton.click()

  // The click only fires an HTTP request. The row's status is written by the SSE handler alone, so a
  // row that leaves `stopped` has been told to by a push. The predicate is "anything but stopped"
  // rather than `starting` specifically: `starting` can be brief enough that a 150 ms poll misses it,
  // and the claim being tested is that the row was told *something*, not which intermediate value.
  await waitForRowStatus(
    row,
    status => status !== 'stopped',
    'the row to leave 已停止',
    fromServer.id,
  )

  // Then: the row must show exactly what the server reports. This is the half an optimistic paint
  // fails — a renderer that decided on its own would show a status the server never sent.
  const afterLaunch = await api(API_ROUTES.runtimeFor(fromServer.id))
  await waitForRowStatus(
    row,
    afterLaunch.status,
    `the row to show the server's "${afterLaunch.status}"`,
    fromServer.id,
  )
  console.log(
    `  server says    : ${afterLaunch.status}${afterLaunch.lastError ? ` (${afterLaunch.lastError.slice(0, 60)}…)` : ''}`,
  )
  console.log(`  renderer shows : ${afterLaunch.status} (${await domStatusText(row)})`)

  /* 3 — stop */
  step('stop it')
  const stopButton = row.getByRole('button', { name: '停止', exact: true })
  if ((await stopButton.count()) > 0) {
    await stopButton.click()
    console.log('  triggered by clicking 停止 in the row')
  } else {
    // Without an engine the launch ends in `error` rather than `running`, and an errored row offers
    // 启动 (a retry) instead of 停止 — the UI legitimately has nothing to click. The stop is issued
    // directly, and the assertion below is unchanged: it still requires the DOM to reach 已停止 from
    // the server's own answer. What this branch does NOT cover is the 停止 button's click handler,
    // which needs a launch that reaches an active state; the log names it rather than hiding it.
    await api(API_ROUTES.stopProfile(fromServer.id), { method: 'POST' })
    console.log('  no 停止 button (launch ended in error, no engine) — stop issued over the API')
  }
  await waitForRowStatus(row, 'stopped', 'the row to return to 已停止', fromServer.id)
  const afterStop = await api(API_ROUTES.runtimeFor(fromServer.id))
  if (afterStop.status !== 'stopped') {
    throw new Error(`the renderer shows 已停止 but the server reports ${afterStop.status}`)
  }
  console.log(`  server agrees  : stopped`)

  /* 4 — reload: nothing may live only in renderer memory */
  step('reload the page')
  await page.reload({ waitUntil: 'load' })
  const rowAfterReload = page.locator('.el-table__row', { hasText: profileName }).first()
  await rowAfterReload.waitFor({ state: 'visible', timeout: 20_000 })
  const reloaded = await api(API_ROUTES.profiles).then(list =>
    list.find(item => item.name === profileName),
  )
  if (!reloaded) throw new Error(`"${profileName}" vanished from the server after a page reload`)
  await waitForRowStatus(
    rowAfterReload,
    'stopped',
    'the reloaded row to show 已停止',
    reloaded.id,
    20_000,
  )
  console.log(`  survived reload: ${reloaded.name} (${reloaded.id}), still stopped`)

  console.log('\nOK — create, launch, stop and reload all agree with the server.')
} catch (error) {
  failure = error
} finally {
  await context?.close().catch(() => {})
  await browser.close()
  await server.close()
  await new Promise(done => staticServer.close(done))
  await rm(dataDir, { recursive: true, force: true })
  await rm(noEngineDir, { recursive: true, force: true })
}

if (failure) {
  console.error(`\nFAILED: ${failure.message}`)
  process.exit(1)
}
