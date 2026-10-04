/**
 * Screenshots of the real UI, produced without Electron.
 *
 * Electron cannot start in the development sandbox (Chromium cannot create its sandboxed child
 * processes), so the UI is proven a different way that is arguably stronger for CI: the **built**
 * renderer from `out/renderer` is served over loopback and driven by headless Chromium, talking to
 * the **real** `@vfox/server` over the **real** HTTP/SSE contract. Only the handful of bridge
 * capabilities that genuinely need Electron (`openPath`, `revealPath`, `openHomepage`, `pickImport`,
 * `saveExport`, `saveText`, `restartService`) are stubbed; everything else is production code.
 *
 *   pnpm --filter @vfox/desktop build
 *   node scripts/screenshot-ui.mjs
 *
 * Requires `playwright` and an installed Chromium (`npx playwright install chromium`). In CI the
 * browser cache is redirected by `scripts/dev-env.ps1` / `PLAYWRIGHT_BROWSERS_PATH`.
 *
 * Exits non-zero if a screenshot is missing, suspiciously small, if the profile list came back
 * empty, or if the renderer throws — a screenshot of an error state is worse than no screenshot.
 *
 * DO NOT turn the bridge injection back into a hand-built source string. It used to be one, and a
 * single stub was written as `profileUsage: async () => ${JSON.stringify(usage)}`. An arrow function
 * with a concise body needs an object literal parenthesised, so the emitted source was
 * `async () => {"path":"…"}`: `{…}` parsed as a function *body*, `"path"` became a string-literal
 * label, and the `:` was a syntax error. The whole injected script failed to parse, `window.vfox`
 * was never assigned, the renderer threw on `window.vfox.apiBase`, and the only symptom was
 * `.el-table__row` timing out 30 s later. Passing a real function plus a plain-data argument lets
 * Playwright serialise both, so there is no hand-built source left to get wrong.
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
const SHOT_NAMES = [
  '1-profiles-table',
  '2-new-profile-dialog',
  '3-settings',
  '4-no-core',
  '5-sync',
  '6-batch-create',
  '7-cookies',
]

if (!existsSync(join(rendererDir, 'index.html'))) {
  console.error(`No built renderer at ${rendererDir}. Run: pnpm --filter @vfox/desktop build`)
  process.exit(2)
}

/*
 * Self-check the bridge injection before anything expensive happens. Playwright builds the injected
 * source as `(function)(argument)`, so parsing that exact shape here catches a malformed stub in
 * microseconds instead of as a 30 s selector timeout in CI. Function declarations hoist, so this
 * runs ahead of the definitions below.
 */
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

/* ------------------------------------------------------------------- bridge injection */

/**
 * Mirrors what `src/preload/index.ts` exposes through contextBridge. The renderer cannot tell the
 * difference except for the capabilities that need Electron, listed in the file header.
 *
 * Playwright serialises this function and runs it in the page, so it must not close over anything:
 * everything it needs arrives in `bridge`, which is plain data.
 */
function installBridge(bridge) {
  window.vfox = {
    apiBase: bridge.apiBase,
    token: bridge.token,
    version: bridge.version,
    platform: bridge.platform,
    dataDir: bridge.dataDir,
    dataMode: bridge.dataMode,
    serviceError: bridge.serviceError,
    openPath: async () => '',
    revealPath: async () => true,
    openHomepage: async () => 'https://github.com/teddyli18000/vitrual_browser',
    probeProxy: async () => ({ ok: true, ms: 18, message: 'TCP 连接成功' }),
    restartService: async () => ({
      ok: false,
      url: bridge.apiBase,
      token: '',
      error: '截图环境无法重启主进程',
    }),
    profileDir: async () => bridge.profileDir,
    profileUsage: async () => bridge.usage,
    saveExport: async () => ({ saved: false, path: null }),
    saveText: async () => ({ saved: false, path: null }),
    pickImport: async () => null,
  }
}

/** Plain data only — Playwright JSON-serialises this into the page as the function's argument. */
function bridgeData(info) {
  const profileDir = join(info.dataDir, 'profiles', 'demo-profile', 'userdata')
  return {
    apiBase: info.apiBase,
    token: info.token,
    version: info.version,
    platform: info.platform,
    dataDir: info.dataDir,
    dataMode: info.dataMode,
    serviceError: info.serviceError,
    profileDir,
    usage: { path: profileDir, exists: true, bytes: 189_743_104, files: 4213 },
  }
}

/**
 * Reproduces Playwright's own serialisation — `coreBundle.js`: `(${fun.toString()})(${argString})` —
 * and parses it, without a browser and without executing it. This is the guard that would have
 * caught the unparenthesised-arrow-body bug here instead of in CI, and it costs microseconds.
 */
function assertBridgeParses(data, label) {
  const source = `(${installBridge.toString()})(${JSON.stringify(data)})`
  try {
    // Parses the source without running it; `new Function` is the cheapest real parser available.
    new Function(source)
  } catch (error) {
    console.error(`The injected bridge script for "${label}" does not parse: ${error.message}`)
    console.error(source)
    process.exit(2)
  }
}

/* ------------------------------------------------------------------- browser preflights */

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error(
    'playwright is not installed. Run: pnpm install, then: npx playwright install chromium',
  )
  process.exit(2)
}

// Fail with something actionable rather than Playwright's own "Executable doesn't exist" stack:
// the browser download is a separate step from the package install and CI forgets it easily.
const browserPath = chromium.executablePath()
if (!existsSync(browserPath)) {
  console.error(
    `Chromium is not installed for Playwright (expected at ${browserPath}).\n` +
      'Run: npx playwright install chromium',
  )
  process.exit(2)
}

/* ------------------------------------------------------------------------ page watching */

/**
 * Collects everything a broken page reports. `error` is the fatal one: a page error means the
 * renderer never mounted, so waiting out a selector timeout would only hide the cause.
 */
function watch(page, label) {
  const state = { error: null, problems: [] }
  const note = message => {
    state.problems.push(`[${label}] ${message}`)
  }
  page.on('pageerror', error => {
    state.error ??= error.message
    note(`pageerror: ${error.message}`)
  })
  page.on('console', message => {
    if (message.type() === 'error') note(`console: ${message.text()}`)
  })
  page.on('requestfailed', request =>
    note(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  )
  return state
}

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

function timeoutMessage(description, watchState) {
  const suffix = watchState.error ? ` — renderer error: ${watchState.error}` : ''
  return `timeout waiting for ${description}${suffix}`
}

/**
 * Waits for a locator, aborting the moment the page reports a JS error. Without this a broken
 * renderer is reported as a bare selector timeout, which names the symptom instead of the cause.
 */
async function waitFor(
  locator,
  description,
  watchState,
  { state = 'visible', timeoutMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (watchState.error) {
      throw new Error(`the renderer threw before ${description} appeared: ${watchState.error}`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(timeoutMessage(description, watchState))
    try {
      await locator.waitFor({ state, timeout: Math.min(500, remaining) })
      return
    } catch {
      if (Date.now() >= deadline) throw new Error(timeoutMessage(description, watchState))
      await sleep(50)
    }
  }
}

/* ----------------------------------------------------------------------------- run */

const shots = []
const watchStates = []

async function capture(page, name) {
  const file = join(shotDir, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  console.log(`  shot   ${name}.png`)
}

await rm(dataDir, { recursive: true, force: true })
await mkdir(shotDir, { recursive: true })
// Remove only the files this run owns: `.cache/shots` may hold someone else's capture.
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
  const pageWatch = watch(page, 'profiles')
  watchStates.push(pageWatch)
  await page.addInitScript(installBridge, bridgeData(live))
  await page.goto(baseUrl, { waitUntil: 'load' })
  await waitFor(page.locator('.el-table__row').first(), 'the first profile row', pageWatch, {
    timeoutMs: 30_000,
  })
  const rows = await page.locator('.el-table__row').count()
  console.log(`  rows   ${rows}`)
  if (rows !== EXPECTED_ROWS) throw new Error(`expected ${EXPECTED_ROWS} profile rows, saw ${rows}`)
  await sleep(400)
  await capture(page, '1-profiles-table')

  /*
   * 2 — the create dialog, on the 指纹 tab where the 自动 indicators live.
   * Each step waits for something only the *next* state can show, so a missed keystroke or a click
   * swallowed by the modal overlay fails loudly instead of quietly shooting the wrong screen.
   */
  await page.keyboard.press('Control+n')
  await waitFor(page.locator('.el-dialog'), 'the create dialog', pageWatch, { timeoutMs: 15_000 })
  await waitFor(page.getByText('新建环境').first(), 'the dialog title', pageWatch, {
    timeoutMs: 15_000,
  })
  await page.locator('.el-tabs__item', { hasText: '指纹' }).first().click()
  // '操作系统' exists only on the 指纹 tab.
  await waitFor(page.getByText('操作系统').first(), 'the 指纹 tab', pageWatch, {
    timeoutMs: 15_000,
  })
  await sleep(600)
  await capture(page, '2-new-profile-dialog')
  await page.keyboard.press('Escape')
  await waitFor(page.locator('.el-dialog'), 'the dialog to close', pageWatch, {
    state: 'hidden',
    timeoutMs: 15_000,
  })

  /* 3 — settings: storage mode, API, engine */
  await page.locator('.nav-item', { hasText: '设置' }).first().click()
  // '存储模式' is unique to 设置, so a click that never landed cannot pass as a settings shot.
  await waitFor(page.getByText('存储模式').first(), 'the 设置 page', pageWatch, {
    timeoutMs: 15_000,
  })
  await sleep(700)
  await capture(page, '3-settings')

  /* 4 — degradation: a dead API must render the banner, never a blank page */
  const offline = await context.newPage()
  const offlineWatch = watch(offline, 'offline')
  watchStates.push(offlineWatch)
  await offline.addInitScript(
    installBridge,
    bridgeData({ ...live, apiBase: 'http://127.0.0.1:1', token: '', serviceError: null }),
  )
  await offline.goto(baseUrl, { waitUntil: 'load' })
  await waitFor(offline.locator('.banner'), 'the offline banner', offlineWatch, {
    timeoutMs: 30_000,
  })
  await sleep(400)
  await capture(offline, '4-no-core')

  /*
   * 5 — the window synchroniser. This harness launches no profile (that needs the 493 MB engine),
   * so the honest first-run state is the one to photograph: the "at least two running" warning,
   * a picker whose controls are all disabled, and the page-level limitation note. The note is an
   * acceptance criterion of its own, so the shot is only taken once it is on screen — a screenshot
   * of a half-rendered view would be worse than none.
   *
   * A run that ever starts profiles must revisit the warning assertion below together with the
   * seed it depends on; nothing here fabricates a running profile to make the page look busier.
   */
  await page.locator('.nav-item', { hasText: '窗口同步' }).first().click()
  await waitFor(page.getByText('同步范围（请务必了解）').first(), 'the 窗口同步 page', pageWatch, {
    timeoutMs: 15_000,
  })
  await waitFor(
    page.getByText('至少需要两个正在运行的环境').first(),
    'the "two running profiles" warning',
    pageWatch,
    { timeoutMs: 15_000 },
  )
  await sleep(600)
  await capture(page, '5-sync')

  /*
   * 6 — the batch-creation dialog. Captured last so it cannot disturb the navigation the earlier
   * steps depend on: back to 环境列表, open 批量创建, type a prefix, and wait for the name preview.
   * The preview is the whole point of the dialog — the names are how the user tells twenty windows
   * apart — so the shot is only taken once chips are actually on screen.
   */
  await page.locator('.nav-item', { hasText: '环境列表' }).first().click()
  await waitFor(page.locator('.el-table__row').first(), 'the profile table again', pageWatch, {
    timeoutMs: 15_000,
  })
  await page.locator('.toolbar .el-button', { hasText: '批量创建' }).first().click()
  await waitFor(page.getByText('批量创建环境').first(), 'the batch dialog', pageWatch, {
    timeoutMs: 15_000,
  })
  await page.locator('label.field', { hasText: '名称前缀' }).locator('input').fill('工作号')
  await waitFor(page.locator('.chip').first(), 'the batch name preview', pageWatch, {
    timeoutMs: 15_000,
  })
  await sleep(600)
  await capture(page, '6-batch-create')

  /*
   * 7 — the cookie import dialog, reached the way a user reaches it: the row's 更多 menu, not a
   * direct URL. This harness has no cookies.txt to pick and launches no profile, so the honest
   * state is what gets photographed: the three facts (format, must-be-stopped, what the format
   * cannot carry), the merge/replace choice, and an 导入 button that is disabled until a file is
   * chosen. The shot is only taken once the facts block is on screen — the dialog box alone would
   * prove nothing about the part users have to read.
   */
  await page.keyboard.press('Escape')
  await waitFor(
    page.locator('.el-dialog', { hasText: '批量创建环境' }),
    'the batch dialog to close',
    pageWatch,
    { state: 'hidden', timeoutMs: 15_000 },
  )
  await page
    .locator('.el-table__row')
    .first()
    .locator('button', { hasText: '更多' })
    .first()
    .click()
  await page.locator('.el-dropdown-menu__item', { hasText: '导入 Cookie' }).first().click()
  await waitFor(page.getByText('导入前请确认').first(), 'the cookie import dialog', pageWatch, {
    timeoutMs: 15_000,
  })
  await waitFor(page.getByText('Netscape cookies.txt').first(), 'the format note', pageWatch, {
    timeoutMs: 15_000,
  })
  await sleep(600)
  await capture(page, '7-cookies')
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await api.close()
  await new Promise(done => staticServer.close(done))
  await rm(dataDir, { recursive: true, force: true })
}

const problems = watchStates.flatMap(state => state.problems)
if (problems.length > 0) {
  console.log('\npage diagnostics (not fatal on their own, but read them):')
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

if (shots.length !== 7) {
  console.error(`FAILED: expected 7 screenshots, produced ${shots.length}`)
  process.exit(1)
}

console.log(`\n${shots.length} screenshots in ${shotDir}`)
