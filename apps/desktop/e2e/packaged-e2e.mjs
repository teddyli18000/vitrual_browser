/**
 * packaged-e2e.mjs — full-flow end-to-end test against the **packaged** application.
 *
 * Why this exists: every other CI job launches the engine from source
 * (`packages/core/scripts/*` against `packages/core/dist`). Nothing has ever launched a browser from
 * the artifact users install, so an entire class of packaging defects is invisible to CI. It was
 * invisible in exactly that way in v0.2.0: `camoufox-js/dist/data-files/webgl_data.db` shipped
 * *inside* `app.asar`, better-sqlite3 is a native module that cannot read through the asar shim, and
 * every profile creation failed with `unable to open database file` (SQLITE_CANTOPEN).
 *
 * What it does, in order:
 *   1. structural guard — the WebGL database must be a real file under `app.asar.unpacked`
 *      (this is the check that catches v0.2.0, and it needs no Electron to run);
 *   2. launch the packaged `VFox.exe` through Playwright's `_electron`, in portable mode;
 *   3. drive the real UI to create a profile and start it;
 *   4. assert a real, visible OS window appeared (via the shared user32 helper, not a second one);
 *   5. assert the WebGL sampler ran: no database error anywhere, and the page reports a real
 *      WebGL vendor/renderer;
 *   6. assert identity: user agent, screen, WebGL from inside the page;
 *   7. stop, restart, and assert cookies and localStorage survived;
 *   8. assert nothing is left behind: no orphaned engine processes, and the data directory is where
 *      portable mode says it should be.
 *
 * Usage:
 *   node apps/desktop/e2e/packaged-e2e.mjs --app <packaged dir or portable .zip>
 *   VFOX_E2E_APP=<path> node apps/desktop/e2e/packaged-e2e.mjs
 *
 * It requires an interactive desktop (it opens a real window) and a packaged build. Neither exists
 * on a sandboxed developer machine, so it is a CI-first test by design.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { checkWebglDatabase, describeArtifact } from './lib/artifact.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

/** `packages/core/scripts/lib/user32.mjs` — the one window/process lookup in this repository. */
const user32 = await import(path.join(repoRoot, 'packages', 'core', 'scripts', 'lib', 'user32.mjs'))

const failures = []
const notes = []

function step(message) {
  console.log(`\n=== ${message}`)
}
function pass(message) {
  console.log(`PASS  ${message}`)
}
function fail(message) {
  console.log(`FAIL  ${message}`)
  failures.push(message)
}
function note(message) {
  notes.push(message)
  console.log(`note  ${message}`)
}
function assert(condition, message) {
  if (condition) pass(message)
  else fail(message)
  return Boolean(condition)
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const appTarget = path.resolve(
  argument('app') ?? process.env.VFOX_E2E_APP ?? 'release/win-unpacked',
)
const keepData = process.argv.includes('--keep-data')

// ------------------------------------------------------------------------------------ 1. artifact
step(`1. packaged artifact: ${appTarget}`)
if (!existsSync(appTarget)) {
  fail(`the packaged artifact ${appTarget} does not exist; build it or pass --app`)
  report()
}

let artifact
try {
  artifact = await describeArtifact(appTarget)
} catch (error) {
  fail(`could not read the packaged artifact: ${error.message}`)
  report()
}

if (artifact.kind === 'zip') {
  fail(
    'a portable .zip was passed; the test needs the extracted application so it can launch ' +
      `${artifact.executable ?? 'VFox.exe'} — unzip it first (the release job does this)`,
  )
  report()
}

note(`executable: ${artifact.executable}`)
const webgl = checkWebglDatabase(artifact)
assert(webgl.ok, `WebGL database is unpacked (${webgl.detail})`)
for (const problem of webgl.problems) console.log(`      ${problem}`)
if (!webgl.ok) report()

if (!existsSync(artifact.executable)) {
  fail(`the packaged executable ${artifact.executable} is missing`)
  report()
}

// ---------------------------------------------------------------- 2. portable mode + launching
// Portable mode is chosen by the app itself when a `portable` marker or a `data/` directory sits
// next to the executable, so creating them here also tests that rule rather than assuming it.
const appDir = path.dirname(artifact.executable)
const dataDir = path.join(appDir, 'data')
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
writeFileSync(
  path.join(appDir, 'portable'),
  'written by apps/desktop/e2e/packaged-e2e.mjs so the test runs against its own data directory\n',
)

const { _electron: electron } = await import('playwright')
const { firefox } = await import('playwright-core')

step('2. launching the packaged application')
let app
try {
  app = await electron.launch({
    executablePath: artifact.executable,
    args: [],
    env: {
      ...process.env,
      // Belt and braces against a stray harness variable: this test needs the real Electron, not a
      // Node interpreter wearing its clothes.
      ELECTRON_RUN_AS_NODE: '',
      VFOX_DATA_DIR: dataDir,
    },
    timeout: 120_000,
  })
} catch (error) {
  fail(`the packaged application did not launch: ${error.message}`)
  report()
}

const appErrors = []
app.process().stderr?.on('data', chunk => {
  const text = String(chunk)
  appErrors.push(text)
  for (const line of text.split('\n')) if (line.trim()) console.log(`      [app] ${line.trim()}`)
})

const page = await app.firstWindow({ timeout: 120_000 })
await page.waitForLoadState('domcontentloaded')
pass(`the packaged application opened a window: "${await page.title()}"`)

// The preload bridge is the app's own contract for reaching its in-process HTTP server.
const bridge = await page.evaluate(() => globalThis.vfox ?? null)
if (!bridge?.apiBase || !bridge?.token) {
  fail('the preload bridge did not expose { apiBase, token }; the renderer cannot reach the core')
  report()
}
note(`api: ${bridge.apiBase}`)

async function api(route, init = {}) {
  const response = await fetch(`${bridge.apiBase}${route}`, {
    ...init,
    headers: { 'x-vfox-token': bridge.token, 'content-type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

// -------------------------------------------------------------------------- 3. drive the real UI
step('3. creating a profile through the UI')
const profileName = `e2e-${Date.now()}`
try {
  await page
    .getByRole('button', { name: /新建环境|New profile/i })
    .first()
    .click({ timeout: 30_000 })
  const dialog = page.locator('.el-dialog').first()
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })
  await dialog.locator('input').first().fill(profileName)
  await dialog
    .getByRole('button', { name: /确定|保存|OK|Save/i })
    .first()
    .click({ timeout: 30_000 })
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
  pass(`created "${profileName}" through the UI`)
} catch (error) {
  fail(`could not create a profile through the UI: ${error.message}`)
  note('if this is a selector drift, the API path below still exercises the packaging bugs')
}

step('4. the profile exists and starts')
const listed = await api('/api/v1/profiles')
const profile = (listed.body?.data ?? []).find(candidate => candidate.name === profileName)
if (!profile) {
  fail(
    `the created profile is not in the API listing: ${JSON.stringify(listed.body)?.slice(0, 400)}`,
  )
  report()
}
pass(`profile ${profile.id} is listed`)

const started = await api('/api/v1/launch', {
  method: 'POST',
  body: JSON.stringify({ id: profile.id }),
})
if (started.status !== 200 && started.status !== 409) {
  fail(`launching the profile failed with HTTP ${started.status}: ${JSON.stringify(started.body)}`)
  report()
}

// A visible OS window is the claim that "it can be used like a normal browser window".
step('5. a real, visible browser window exists')
let window = null
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const engine = await user32.listEngineProcesses()
  window = user32.pickLargestWindow(engine.windows ?? [], engine.pids ?? [])
  if (window) break
  await new Promise(resolve => setTimeout(resolve, 2000))
}
if (!window) {
  fail(
    'no visible browser window appeared within 120 s. If CIM is unavailable on this runner the ' +
      'pid walk degrades to the launcher pid alone; check the engine processes directly.',
  )
} else {
  pass(
    `visible window ${window.width}x${window.height} at ${window.x},${window.y} ` +
      `(title "${window.title ?? ''}")`,
  )
}

// ------------------------------------------------------- 6. the WebGL database really was opened
step('6. the WebGL sampler ran (the v0.2.0 regression)')
const databaseErrors = appErrors
  .join('')
  .split('\n')
  .filter(line => /unable to open database|SQLITE_CANTOPEN|webgl_data\.db/i.test(line))
assert(
  databaseErrors.length === 0,
  'the application reported no WebGL database error' +
    (databaseErrors.length ? `: ${databaseErrors.join(' | ')}` : ''),
)

const runtime = await api(`/api/v1/runtime/${profile.id}`)
const wsEndpoint = runtime.body?.data?.wsEndpoint ?? null
if (!wsEndpoint) {
  fail(
    `the profile did not expose a wsEndpoint (runtime: ${JSON.stringify(runtime.body)?.slice(0, 300)}); ` +
      'the identity and state assertions cannot run',
  )
  report()
}

// A tiny origin of our own: `about:blank` has an opaque origin, where localStorage throws.
const origin = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>vfox-e2e</title><h1>vfox e2e</h1>')
})
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
const originUrl = `http://127.0.0.1:${origin.address().port}/`

const browser = await firefox.connect(wsEndpoint)
const context = browser.contexts()[0] ?? (await browser.newContext())
const profilePage = await context.newPage()
await profilePage.goto(originUrl, { waitUntil: 'load' })

const identity = await profilePage.evaluate(() => {
  // A canvas has exactly one context type: asking the same element for 'webgl' after '2d' returns
  // null. That mistake is what made the first engine smoke run report no WebGL evidence at all.
  const gl = document.createElement('canvas').getContext('webgl')
  const debug = gl?.getExtension('WEBGL_debug_renderer_info')
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screen: `${screen.width}x${screen.height}`,
    webglVendor: debug
      ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
      : (gl?.getParameter(gl.VENDOR) ?? null),
    webglRenderer: debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : (gl?.getParameter(gl.RENDERER) ?? null),
  }
})
note(`identity: ${JSON.stringify(identity)}`)
assert(/Firefox\//.test(identity.userAgent), `the page is a real Firefox: ${identity.userAgent}`)
assert(
  Boolean(identity.webglVendor && identity.webglRenderer),
  'WebGL vendor and renderer are readable',
)

// --------------------------------------------------------------- 7. state survives a restart
step('7. cookies and localStorage survive a restart')
const state = { cookie: `e2e=${profileName}`, storage: `e2e-${profileName}` }
await profilePage.evaluate(value => localStorage.setItem('vfox-e2e', value), state.storage)
await profilePage.context().addCookies([{ name: 'vfox-e2e', value: state.cookie, url: originUrl }])
await profilePage.close()

await api('/api/v1/stop', { method: 'POST', body: JSON.stringify({ id: profile.id }) })
await new Promise(resolve => setTimeout(resolve, 5000))
await api('/api/v1/launch', { method: 'POST', body: JSON.stringify({ id: profile.id }) })

const restarted = await (async () => {
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    const state = await api(`/api/v1/runtime/${profile.id}`)
    const endpoint = state.body?.data?.wsEndpoint
    if (endpoint) return endpoint
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return null
})()
if (!restarted) {
  fail('the profile did not come back up after a restart')
  report()
}

const browser2 = await firefox.connect(restarted)
const context2 = browser2.contexts()[0] ?? (await browser2.newContext())
const page2 = await context2.newPage()
await page2.goto(originUrl, { waitUntil: 'load' })
const restored = await page2.evaluate(() => ({
  storage: localStorage.getItem('vfox-e2e'),
  cookies: document.cookie,
}))
assert(
  restored.storage === state.storage,
  `localStorage survived: ${JSON.stringify(restored.storage)}`,
)
assert(
  restored.cookies.includes(state.cookie),
  `cookies survived: ${JSON.stringify(restored.cookies)}`,
)
await page2.close()

// ------------------------------------------------------------------- 8. nothing left behind
step('8. nothing is left behind')
await api('/api/v1/stop', { method: 'POST', body: JSON.stringify({ id: profile.id }) })
await new Promise(resolve => setTimeout(resolve, 5000))

const after = await user32.listEngineProcesses()
assert(
  (after.pids ?? []).length === 0,
  `no engine processes survive the stop (found ${JSON.stringify(after.pids ?? [])})`,
)
assert(
  existsSync(path.join(dataDir, 'profiles.json')),
  `portable mode put the store in <app>/data: ${path.join(dataDir, 'profiles.json')}`,
)

await app.close()
if (!keepData) rmSync(dataDir, { recursive: true, force: true })
origin.close()

report()

/** Print the summary and exit non-zero on any failure. */
function report() {
  console.log(`\n${'='.repeat(72)}`)
  if (notes.length > 0) {
    console.log(`notes (${notes.length}):`)
    for (const entry of notes) console.log(`  - ${entry}`)
  }
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} assertion(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('packaged end-to-end test PASSED')
  process.exit(0)
}
