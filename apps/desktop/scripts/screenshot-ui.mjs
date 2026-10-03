/**
 * Screenshots of the real UI, produced without Electron.
 *
 * Electron cannot start in the development sandbox (Chromium cannot create its sandboxed child
 * processes), so the UI is proven a different way that is arguably stronger for CI: the **built**
 * renderer from `out/renderer` is served over loopback and driven by headless Chromium, talking to
 * the **real** `@vfox/server` over the **real** HTTP/SSE contract. Only the handful of bridge
 * capabilities that genuinely need Electron (`openPath`, `revealPath`, `openHomepage`, `pickImport`,
 * `saveExport`, `restartService`) are stubbed; everything else is production code.
 *
 *   pnpm --filter @vfox/desktop build
 *   node scripts/screenshot-ui.mjs
 *
 * Requires `playwright` and an installed Chromium (`npx playwright install chromium`). In CI the
 * browser cache is redirected by `scripts/dev-env.ps1` / `PLAYWRIGHT_BROWSERS_PATH`.
 *
 * Exits non-zero if a screenshot is missing, suspiciously small, or if the profile list came back
 * empty — a screenshot of an error state is worse than no screenshot.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '@vfox/server'
import { seedDemoData } from './demo-data.mjs'
import { createStaticServer } from './static-server.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..')
const rendererDir = join(appRoot, 'out', 'renderer')
const shotDir = join(appRoot, '.cache', 'shots')
const dataDir = join(appRoot, '.cache', 'tmp', `ui-shots-${process.pid}`)

const VIEWPORT = { width: 1440, height: 900 }
const MIN_SCREENSHOT_BYTES = 4096
const EXPECTED_ROWS = 8
/** Written in this order; also the exact set removed before a run, so nothing else is touched. */
const SHOT_NAMES = ['1-profiles-table', '2-new-profile-dialog', '3-settings', '4-no-core']

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

/**
 * Mirrors what `src/preload/index.ts` exposes through contextBridge. The renderer cannot tell the
 * difference except for the capabilities that need Electron, listed in the file header.
 */
function bridgeInitScript(info) {
  const profileDir = join(info.dataDir, 'profiles', 'demo-profile', 'userdata')
  const usage = { path: profileDir, exists: true, bytes: 189_743_104, files: 4213 }
  return `window.vfox = {
  apiBase: ${JSON.stringify(info.apiBase)},
  token: ${JSON.stringify(info.token)},
  version: ${JSON.stringify(info.version)},
  platform: ${JSON.stringify(info.platform)},
  dataDir: ${JSON.stringify(info.dataDir)},
  dataMode: ${JSON.stringify(info.dataMode)},
  serviceError: ${JSON.stringify(info.serviceError)},
  openPath: async () => '',
  revealPath: async () => true,
  openHomepage: async () => 'https://github.com/teddyli18000/vitrual_browser',
  probeProxy: async () => ({ ok: true, ms: 18, message: 'TCP 连接成功' }),
  restartService: async () => ({ ok: false, url: ${JSON.stringify(info.apiBase)}, token: '', error: '截图环境无法重启主进程' }),
  profileDir: async () => ${JSON.stringify(profileDir)},
  profileUsage: async () => ${JSON.stringify(usage)},
  saveExport: async () => ({ saved: false, path: null }),
  pickImport: async () => null,
}`
}

const shots = []
const problems = []

function watch(page, label) {
  page.on('pageerror', error => problems.push(`[${label}] pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`[${label}] console: ${message.text()}`)
  })
  page.on('requestfailed', request =>
    problems.push(
      `[${label}] requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  )
}

async function capture(page, name) {
  const file = join(shotDir, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  console.log(`  shot   ${name}.png`)
}

await rm(dataDir, { recursive: true, force: true })
await mkdir(shotDir, { recursive: true })
// Remove only the four files this run owns: `.cache/shots` may hold someone else's capture.
for (const name of SHOT_NAMES) await rm(join(shotDir, `${name}.png`), { force: true })
console.log(`seeding  ${dataDir}`)
const seeded = await seedDemoData(dataDir, () => {})
console.log(`seeded   ${seeded.profiles.length} profile(s), ${seeded.groups.length} group(s)`)

const api = await startServer({ dataDir, port: 0 })
const staticServer = createStaticServer(rendererDir)
await new Promise((done, fail) => {
  staticServer.once('error', fail)
  staticServer.listen(0, '127.0.0.1', done)
})
const baseUrl = `http://127.0.0.1:${staticServer.address().port}`
console.log(`api      ${api.url}`)
console.log(`renderer ${baseUrl}`)

const live = {
  apiBase: api.url,
  token: api.token,
  version: '0.1.0',
  platform: 'win32',
  dataDir,
  dataMode: 'custom',
  serviceError: null,
}

// Chromium's own sandbox cannot start on some CI images; this browser only ever loads our page.
const launchArgs = process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
const browser = await chromium.launch({ args: launchArgs })
let failure = null

try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  })

  /* 1 — the profiles table, talking to the real API */
  const page = await context.newPage()
  watch(page, 'profiles')
  await page.addInitScript(bridgeInitScript(live))
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('.el-table__row', { timeout: 30_000 })
  const rows = await page.locator('.el-table__row').count()
  console.log(`  rows   ${rows}`)
  if (rows !== EXPECTED_ROWS) throw new Error(`expected ${EXPECTED_ROWS} profile rows, saw ${rows}`)
  await page.waitForTimeout(400)
  await capture(page, '1-profiles-table')

  /* 2 — the create dialog, on the 指纹 tab where the 自动 indicators live */
  await page.keyboard.press('Control+n')
  await page.waitForSelector('.el-dialog', { timeout: 15_000 })
  await page.locator('.el-tabs__item', { hasText: '指纹' }).first().click()
  await page.waitForTimeout(600)
  await capture(page, '2-new-profile-dialog')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  /* 3 — settings: storage mode, API, engine */
  await page.locator('.nav-item', { hasText: '设置' }).first().click()
  await page.waitForSelector('.card-title', { timeout: 15_000 })
  await page.waitForTimeout(700)
  await capture(page, '3-settings')

  /* 4 — degradation: a dead API must render the banner, never a blank page */
  const offline = await context.newPage()
  watch(offline, 'offline')
  await offline.addInitScript(
    bridgeInitScript({ ...live, apiBase: 'http://127.0.0.1:1', token: '', serviceError: null }),
  )
  await offline.goto(baseUrl, { waitUntil: 'load' })
  await offline.waitForSelector('.banner', { timeout: 30_000 })
  await offline.waitForTimeout(400)
  await capture(offline, '4-no-core')
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await api.close()
  await new Promise(done => staticServer.close(done))
  await rm(dataDir, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.log('\npage diagnostics (not fatal, but read them):')
  for (const problem of problems) console.log(`  ${problem}`)
}

if (failure) {
  console.error(`\nFAILED: ${failure.message}`)
  process.exit(1)
}

for (const file of shots) {
  const info = await stat(file)
  if (info.size < MIN_SCREENSHOT_BYTES) {
    console.error(`FAILED: ${file} is only ${info.size} bytes — the page probably did not render`)
    process.exit(1)
  }
  console.log(`${file}  ${info.size} bytes`)
}

if (shots.length !== 4) {
  console.error(`FAILED: expected 4 screenshots, produced ${shots.length}`)
  process.exit(1)
}

console.log(`\n${shots.length} screenshots in ${shotDir}`)
