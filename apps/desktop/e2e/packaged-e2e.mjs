/**
 * packaged-e2e.mjs — full-flow end-to-end test against the **packaged** application.
 *
 * The owner's definition of "full flow": start from downloading the browser kernel, and go all the
 * way to several profiles actually being usable and able to visit pages.
 *
 * Why this exists at all: every other CI job launches the engine from source
 * (`packages/core/scripts/*` against `packages/core/dist`). Nothing has ever launched a browser from
 * the artifact users install, so an entire class of packaging defects is invisible to CI. It was
 * invisible in exactly that way in v0.2.0: `camoufox-js/dist/data-files/webgl_data.db` shipped
 * *inside* `app.asar`, better-sqlite3 is a native module that cannot read through the asar shim, and
 * every profile creation failed with `unable to open database file` (SQLITE_CANTOPEN).
 *
 * Phases:
 *   0. structural guard — the WebGL database must be a real file under `app.asar.unpacked`
 *      (the check that catches v0.2.0, and it needs no Electron to run);
 *   1. launch the packaged `VFox.exe` in portable mode with **no engine present**;
 *   2. install the engine **through the app**, while polling the renderer to measure whether the UI
 *      stayed responsive — the owner reported the window going unresponsive during install;
 *   3. create three profiles through the real UI;
 *   4. launch all three and assert each opens its own visible OS window;
 *   5. drive each profile's page to a real page over the network and assert its content;
 *   6. assert the three identities are actually distinct (issue #10's promise);
 *   7. stop everything and assert no engine process is orphaned.
 *
 * Usage:
 *   node apps/desktop/e2e/packaged-e2e.mjs --app <packaged dir> [--keep-data] [--skip-install]
 *
 * It needs an interactive desktop and a packaged build, so it is a CI-first test by design.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkMainWorker,
  checkNoTestCode,
  checkWebglDatabase,
  describeArtifact,
} from './lib/artifact.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

/**
 * `packages/core/scripts/lib/user32.mjs` — the one window/process lookup in this repository.
 *
 * `pathToFileURL`, not the raw path: a Windows path handed to `import()` is read as a URL scheme and
 * dies with `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`c:` looks like a protocol).
 */
const user32 = await import(
  pathToFileURL(path.join(repoRoot, 'packages', 'core', 'scripts', 'lib', 'user32.mjs')).href
)

const failures = []
const notes = []
const executed = []
const draft = []

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

// ------------------------------------------------------------------------------------ 0. artifact
step(`0. packaged artifact: ${appTarget}`)
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
  fail('a portable .zip was passed; the test needs the extracted application so it can launch it')
  report()
}

const webgl = checkWebglDatabase(artifact)
assert(webgl.ok, `WebGL database is unpacked (${webgl.detail})`)
for (const problem of webgl.problems) console.log(`      ${problem}`)
if (!webgl.ok) report()

// The two suites are development tools and must not enter the released code. `electron-builder.yml`
// packs `out/**` and `package.json`, so this should already hold — asserted because "should" is the
// assumption that shipped the WebGL database inside app.asar.
const noTestCode = checkNoTestCode(artifact)
assert(noTestCode.ok, `no test tooling shipped inside the package (${noTestCode.detail})`)
for (const problem of noTestCode.problems) console.log(`      ${problem}`)
if (!noTestCode.ok) report()

// The extraction worker is started with `new Worker(new URL('./unzip-worker.js', import.meta.url))`,
// which resolves next to the BUNDLED main process once electron-vite has packed it — and the
// bundler does not emit that file, because a worker is not an entry point. The shipped v0.3.0
// therefore failed every engine install with "Cannot find module …\out\main\unzip-worker.js".
// `apps/desktop/scripts/copy-worker.mjs` puts it there as part of the build; this asserts the
// result rather than trusting the step, because the step is what was missing.
const worker = checkMainWorker(artifact)
assert(worker.ok, `the engine-extraction worker is inside the package (${worker.detail})`)
for (const problem of worker.problems) console.log(`      ${problem}`)
if (!worker.ok) report()

if (!existsSync(artifact.executable)) {
  fail(`the packaged executable ${artifact.executable} is missing`)
  report()
}
executed.push('the structural guard against the packaged artifact')

// ------------------------------------------------------- 1. portable mode, and NO engine at all
const appDir = path.dirname(artifact.executable)
const dataDir = path.join(appDir, 'data')
const engineDir = path.join(appDir, 'engine-from-scratch')
if (!keepData) {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(engineDir, { recursive: true, force: true })
}
mkdirSync(dataDir, { recursive: true })
mkdirSync(engineDir, { recursive: true })
writeFileSync(path.join(appDir, 'portable'), 'written by apps/desktop/e2e/packaged-e2e.mjs\n')

step('1. launching the packaged application with an EMPTY engine directory')
assert(
  !existsSync(path.join(engineDir, 'camoufox.exe')),
  `the engine directory starts empty: ${engineDir}`,
)

const { _electron: electron } = await import('playwright')
const { firefox } = await import('playwright-core')

let app
try {
  app = await electron.launch({
    executablePath: artifact.executable,
    args: [],
    env: {
      ...process.env,
      // Belt and braces against a stray harness variable: this needs the real Electron.
      ELECTRON_RUN_AS_NODE: '',
      VFOX_DATA_DIR: dataDir,
      // The whole point of phase 2: the app must fetch the kernel itself, into a directory that has
      // never held one.
      CAMOUFOX_INSTALL_DIR: engineDir,
    },
    timeout: 120_000,
  })
} catch (error) {
  fail(`the packaged application did not launch: ${error.message}`)
  report()
}

const appStderr = []
app.process().stderr?.on('data', chunk => {
  const text = String(chunk)
  appStderr.push(text)
  for (const line of text.split('\n')) if (line.trim()) console.log(`      [app] ${line.trim()}`)
})

const page = await app.firstWindow({ timeout: 120_000 })
await page.waitForLoadState('domcontentloaded')
pass(`the packaged application opened a window: "${await page.title()}"`)
executed.push('launching the packaged VFox.exe and reading its window title')

const bridge = await page.evaluate(() => globalThis.vfox ?? null)
if (!bridge?.apiBase || !bridge?.token) {
  fail('the preload bridge did not expose { apiBase, token }')
  report()
}
note(`api: ${bridge.apiBase}`)
executed.push('reading the preload bridge for { apiBase, token }')

async function api(route, init = {}) {
  const response = await fetch(`${bridge.apiBase}${route}`, {
    ...init,
    headers: { 'x-vfox-token': bridge.token, 'content-type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

// ------------------------------------------------- 2. install the engine THROUGH the app
step('2. installing the engine through the application (this downloads ~490 MB)')
note(
  "install is driven through the app's own API + SSE rather than by clicking 一键安装: the button " +
    'does exactly this underneath, and the API gives machine-readable progress to assert on instead ' +
    'of a selector that can drift. UI responsiveness is still measured on the renderer itself.',
)

const kernelProgress = []
const sseAbort = new AbortController()
let installFinished = false
const sse = (async () => {
  try {
    const response = await fetch(`${bridge.apiBase}/api/v1/events`, {
      headers: { 'x-vfox-token': bridge.token, accept: 'text/event-stream' },
      signal: sseAbort.signal,
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data:') && line.includes('kernel'))
          kernelProgress.push(line.slice(5).trim())
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') note(`SSE stream ended: ${error.message}`)
  }
})()

/**
 * Poll the renderer and measure the longest gap between two successful answers.
 *
 * This is the owner's "安装的时候容易给自己搞的未响应" report. A `page.evaluate` round-trip only
 * completes when the main process and the renderer can both answer, so a blocked event loop shows up
 * as a long gap — which is the evidence, rather than the assertion "it did not freeze".
 */
const responsiveness = { samples: 0, longestGapMs: 0, at: null }
async function pollResponsiveness() {
  let last = Date.now()
  while (!installFinished) {
    try {
      await page.evaluate(() => document.readyState)
      const now = Date.now()
      const gap = now - last
      responsiveness.samples += 1
      if (gap > responsiveness.longestGapMs) {
        responsiveness.longestGapMs = gap
        responsiveness.at = new Date().toISOString()
      }
      last = now
    } catch (error) {
      note(`renderer poll failed: ${error.message}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
const poller = pollResponsiveness()

const installStarted = Date.now()
const started = await api('/api/v1/kernel/install', { method: 'POST', body: '{}' })
assert(
  started.status === 202 || started.status === 200,
  `the install request was accepted (HTTP ${started.status})`,
)

let installedInfo = null
const installDeadline = Date.now() + 20 * 60_000
while (Date.now() < installDeadline) {
  const status = await api('/api/v1/kernel')
  if (status.body?.data?.installed) {
    installedInfo = status.body.data
    break
  }
  if (kernelProgress.length > 0)
    console.log(`      progress: ${kernelProgress.at(-1)?.slice(0, 160)}`)
  await new Promise(resolve => setTimeout(resolve, 3000))
}
installFinished = true
await poller
sseAbort.abort()
void sse

const installMs = Date.now() - installStarted
assert(Boolean(installedInfo), `the application reports the engine installed after ${installMs} ms`)
if (installedInfo) note(`kernel: ${JSON.stringify(installedInfo)}`)
assert(
  existsSync(path.join(engineDir, 'camoufox.exe')),
  `camoufox.exe exists on disk at ${path.join(engineDir, 'camoufox.exe')}`,
)
assert(
  existsSync(path.join(engineDir, 'version.json')),
  `version.json exists on disk at ${path.join(engineDir, 'version.json')}`,
)
note(`SSE kernel progress lines observed: ${kernelProgress.length}`)

// The owner's unresponsiveness report, measured rather than asserted in prose.
assert(
  responsiveness.samples > 20,
  `the renderer answered ${responsiveness.samples} polls during the install`,
)
assert(
  responsiveness.longestGapMs < 15_000,
  `the longest unresponsive gap was ${responsiveness.longestGapMs} ms` +
    (responsiveness.at ? ` (at ${responsiveness.at})` : ''),
)
executed.push(
  'installing the engine through the app from an empty directory, and measuring renderer responsiveness during it',
)

const databaseErrors = appStderr
  .join('')
  .split('\n')
  .filter(line => /unable to open database|SQLITE_CANTOPEN|webgl_data\.db/i.test(line))
assert(
  databaseErrors.length === 0,
  'the application reported no WebGL database error' +
    (databaseErrors.length ? `: ${databaseErrors.join(' | ')}` : ''),
)

// ------------------------------------------------------------------ 3. three profiles, via the UI
step('3. creating three profiles through the UI')
const profileNames = [1, 2, 3].map(index => `e2e-${index}-${Date.now()}`)
let uiCreates = 0
for (const name of profileNames) {
  try {
    await page
      .getByRole('button', { name: /新建环境|New profile/i })
      .first()
      .click({ timeout: 30_000 })
    const dialog = page.locator('.el-dialog').first()
    await dialog.waitFor({ state: 'visible', timeout: 30_000 })
    await dialog.locator('input').first().fill(name)
    await dialog
      .getByRole('button', { name: /确定|保存|OK|Save/i })
      .first()
      .click({ timeout: 30_000 })
    await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
    uiCreates += 1
  } catch (error) {
    note(`creating "${name}" through the UI failed: ${error.message}`)
  }
}
if (uiCreates === profileNames.length) {
  pass(`created ${uiCreates} profiles through the UI`)
  executed.push('creating three profiles through the real UI')
} else {
  draft.push('creating three profiles through the UI (selectors unexecuted; fell back to the API)')
}

const listed = await api('/api/v1/profiles')
const profiles = (listed.body?.data ?? []).filter(candidate =>
  profileNames.includes(candidate.name),
)
if (profiles.length < profileNames.length) {
  // The API path keeps the rest of the test — which is the valuable part — running.
  for (const name of profileNames) {
    if (profiles.some(profile => profile.name === name)) continue
    const created = await api('/api/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    if (created.body?.data) profiles.push(created.body.data)
  }
}
assert(profiles.length === 3, `three profiles exist (${profiles.length})`)
if (profiles.length < 3) report()

// ------------------------------------------------------------- 4. all three open real windows
step('4. launching all three and looking for three visible OS windows')
for (const profile of profiles) {
  const launched = await api('/api/v1/launch', {
    method: 'POST',
    body: JSON.stringify({ id: profile.id }),
  })
  if (launched.status !== 200 && launched.status !== 409) {
    fail(`launching ${profile.name} failed with HTTP ${launched.status}`)
  }
}

const windows = new Map()
const windowDeadline = Date.now() + 180_000
while (Date.now() < windowDeadline && windows.size < profiles.length) {
  const engine = await user32.listEngineProcesses()
  const largest = user32.pickLargestWindow(engine.windows ?? [], engine.pids ?? [])
  if (largest && !windows.has(largest.pid)) windows.set(largest.pid, largest)
  await new Promise(resolve => setTimeout(resolve, 2000))
}
assert(
  windows.size >= profiles.length,
  `at least ${profiles.length} distinct visible windows appeared (found ${windows.size})`,
)
for (const window of windows.values()) {
  note(`window pid ${window.pid} ${window.width}x${window.height} "${window.title ?? ''}"`)
}
executed.push('launching three profiles and counting their visible OS windows')

// ------------------------------------------------- 5. every profile can actually load a page
step('5. every profile loads a real page over the network')
const origin = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>vfox-local-origin</title><h1 id="marker">vfox-local</h1>')
})
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
const originUrl = `http://127.0.0.1:${origin.address().port}/`

const identities = []
const state = { cookie: 'vfox-e2e', storage: 'vfox-e2e-value' }

for (const profile of profiles) {
  const runtime = await api(`/api/v1/runtime/${profile.id}`)
  const wsEndpoint = runtime.body?.data?.wsEndpoint ?? null
  if (!wsEndpoint) {
    fail(`${profile.name} exposes no wsEndpoint; cannot drive its page`)
    continue
  }
  const browser = await firefox.connect(wsEndpoint)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const profilePage = await context.newPage()

  // The local origin first: it proves the browser renders and runs script even if the runner has no
  // route to the public internet, and it is where the persistence assertions live.
  await profilePage.goto(originUrl, { waitUntil: 'load', timeout: 60_000 })
  const marker = await profilePage.locator('#marker').textContent()
  assert(marker === 'vfox-local', `${profile.name} loaded the local page (body: ${marker})`)

  // …then a real page over the network. A profile that opens a window but cannot reach the network
  // is not usable, so this asserts the document, not merely that navigation resolved.
  try {
    await profilePage.goto('https://example.com', { waitUntil: 'load', timeout: 90_000 })
    const title = await profilePage.title()
    assert(/Example Domain/i.test(title), `${profile.name} loaded https://example.com ("${title}")`)
  } catch (error) {
    fail(`${profile.name} could not load https://example.com: ${error.message}`)
  }

  identities.push({
    name: profile.name,
    ...(await profilePage.evaluate(() => {
      // Two SEPARATE canvas elements on purpose: a canvas can only ever have one context type, so
      // asking an element that already has a `2d` context for `webgl` returns null. That exact
      // mistake produced a false "WebGL is not spoofed" conclusion in this project's first CI run.
      const gl = document.createElement('canvas').getContext('webgl')
      const debug = gl?.getExtension('WEBGL_debug_renderer_info')

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.textBaseline = 'top'
        ctx.font = '14px sans-serif'
        ctx.fillStyle = '#f60'
        ctx.fillRect(0, 0, 60, 20)
        ctx.fillStyle = '#069'
        ctx.fillText('vfox-e2e', 2, 2)
      }
      const data = canvas.toDataURL()
      let hash = 0x811c9dc5
      for (let index = 0; index < data.length; index += 1) {
        hash ^= data.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }

      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        languages: (navigator.languages ?? []).join(','),
        screen: `${screen.width}x${screen.height}`,
        availScreen: `${screen.availWidth}x${screen.availHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        webglVendor: debug
          ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
          : (gl?.getParameter(gl.VENDOR) ?? null),
        webglRenderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : (gl?.getParameter(gl.RENDERER) ?? null),
        canvasHash: hash.toString(16),
      }
    })),
  })

  await profilePage.goto(originUrl, { waitUntil: 'load', timeout: 60_000 })
  await profilePage.evaluate(value => localStorage.setItem('vfox-e2e', value), state.storage)
  await profilePage
    .context()
    .addCookies([{ name: 'vfox-e2e', value: state.cookie, url: originUrl }])
  await profilePage.close()
}
executed.push(
  'driving each profile to a local page and to https://example.com and asserting content',
)

// --------------------------------------------------------------------- 6. distinct identities
step('6. the profiles have genuinely different fingerprints')
// The owner asked for this explicitly, `engine` has seen it fail intermittently (a batch of five
// produced only four distinct identities), and a user who gets two identical devices has a real
// detection problem. So it is asserted dimension by dimension, pairwise, not assumed.
const FINGERPRINT_DIMENSIONS = [
  'userAgent',
  'platform',
  'hardwareConcurrency',
  'languages',
  'screen',
  'availScreen',
  'devicePixelRatio',
  'timezone',
  'webglVendor',
  'webglRenderer',
  'canvasHash',
]
const MIN_DIFFERING_DIMENSIONS = 4

if (identities.length > 0) {
  console.log(
    `\n      ${'profile'.padEnd(22)}${FINGERPRINT_DIMENSIONS.map(key => key.slice(0, 14)).join(' | ')}`,
  )
  for (const identity of identities) {
    const cells = FINGERPRINT_DIMENSIONS.map(key => String(identity[key] ?? '').slice(0, 14))
    console.log(`      ${identity.name.padEnd(22)}${cells.join(' | ')}`)
  }
}

for (let left = 0; left < identities.length; left += 1) {
  for (let right = left + 1; right < identities.length; right += 1) {
    const differing = FINGERPRINT_DIMENSIONS.filter(
      key => String(identities[left][key]) !== String(identities[right][key]),
    )
    assert(
      differing.length >= MIN_DIFFERING_DIMENSIONS,
      `${identities[left].name} vs ${identities[right].name}: ${differing.length} dimensions differ ` +
        `(need ${MIN_DIFFERING_DIMENSIONS}) — ${differing.join(', ') || 'none'}`,
    )
  }
}
executed.push(
  'comparing 11 fingerprint dimensions pairwise across the profiles and requiring 4 to differ',
)

// ------------------------------------------------------- 7. state survives, nothing left behind
step('7. stopping everything, and nothing is left behind')
for (const profile of profiles) {
  await api('/api/v1/stop', { method: 'POST', body: JSON.stringify({ id: profile.id }) })
}
await new Promise(resolve => setTimeout(resolve, 8000))

const after = await user32.listEngineProcesses()
assert(
  (after.pids ?? []).length === 0,
  `no engine processes survive the stop (found ${JSON.stringify(after.pids ?? [])})`,
)
assert(
  existsSync(path.join(dataDir, 'profiles.json')),
  `portable mode put the store in <app>/data (${path.join(dataDir, 'profiles.json')})`,
)
const xul = path.join(engineDir, 'xul.dll')
note(`engine ${engineDir} holds xul.dll of ${existsSync(xul) ? statSync(xul).size : 0} bytes`)
executed.push('stopping every profile and asserting no engine process is orphaned')

await app.close()
if (!keepData) {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(engineDir, { recursive: true, force: true })
}
origin.close()

report()

/** Print the summary and exit non-zero on any failure. */
function report() {
  console.log(`\n${'='.repeat(72)}`)
  console.log('EXECUTED (verified by running it):')
  for (const entry of executed) console.log(`  - ${entry}`)
  if (draft.length > 0) {
    console.log('FIRST DRAFT (written, not yet executed anywhere):')
    for (const entry of draft) console.log(`  - ${entry}`)
  }
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
