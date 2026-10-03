/**
 * CI smoke test for the window synchroniser.
 *
 * This is the only place the synchroniser is exercised against a real browser: two profiles are
 * launched through the real core, a session is started, a click is performed in the master and the
 * slave page must report that it received it. It also verifies the load-bearing assumption behind
 * the whole design — detaching our client must NOT close the user's window.
 *
 * Prerequisites: `pnpm kernel:fetch` (or a cached Camoufox kernel) and a built workspace
 * (`pnpm --filter @vfox/shared build && pnpm --filter @vfox/core build && pnpm --filter @vfox/sync build`).
 *
 * Environment:
 *   VFOX_SMOKE_HEADLESS=1   launch headless profiles (runners without a desktop session)
 *   VFOX_SMOKE_TILE=strict  treat a tiling failure as a failure (default: report it as a warning)
 *
 * Usage: node packages/sync/scripts/smoke-sync.mjs
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { firefox } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

const headless = process.env.VFOX_SMOKE_HEADLESS === '1'
const strictTile = process.env.VFOX_SMOKE_TILE === 'strict'

const logger = {
  debug: message => log('debug', message),
  info: message => log('info', message),
  warn: message => log('warn', message),
  error: message => log('error', message),
}

function log(level, message) {
  process.stdout.write(`[smoke] ${level}: ${message}\n`)
}

function step(message) {
  process.stdout.write(`[smoke] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[smoke] FAIL: ${message}\n`)
  process.exitCode = 1
}

async function loadModules() {
  const missing = []
  let core
  let sync
  try {
    core = await import('@vfox/core')
  } catch (error) {
    missing.push(`@vfox/core (${error.message})`)
  }
  try {
    sync = await import(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href)
  } catch (error) {
    missing.push(`@vfox/sync dist (${error.message}) — run pnpm --filter @vfox/sync build`)
  }
  if (!core || !sync) {
    fail(`this smoke test needs the built workspace: ${missing.join('; ')}`)
    return null
  }
  return { createCore: core.createCore, createSync: sync.createSync }
}

/** A fresh connection must still find the window: `browser.close()` detaches, it does not stop. */
async function assertWindowStillOpen(profileId, core) {
  const status = core.runtime.get(profileId)
  if (status.status !== 'running' || !status.wsEndpoint) {
    throw new Error(
      `profile "${profileId}" is ${status.status} after the sync session stopped — our detach closed the user's window`,
    )
  }
  const browser = await firefox.connect(status.wsEndpoint)
  try {
    const pages = browser.contexts()[0]?.pages() ?? []
    if (pages.length === 0) {
      throw new Error(`profile "${profileId}" has no page left after the sync session stopped`)
    }
  } finally {
    await browser.close()
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

const modules = await loadModules()
if (!modules) {
  process.exit(process.exitCode ?? 1)
}
const { createCore, createSync } = modules

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-sync-smoke-'))
let core = null
let sync = null
const openConnections = []

try {
  step(`data dir: ${dataDir}`)
  step(`headless: ${headless}`)
  core = await createCore({
    dataDir,
    kernelDir: process.env.CAMOUFOX_INSTALL_DIR,
    logger,
  })

  const master = await core.profiles.create({
    name: 'sync-smoke-master',
    launch: { headless, startUrl: 'about:blank' },
  })
  const slave = await core.profiles.create({
    name: 'sync-smoke-slave',
    launch: { headless, startUrl: 'about:blank' },
  })

  step('launching two real profiles through @vfox/core')
  let masterRuntime
  let slaveRuntime
  try {
    masterRuntime = await core.runtime.launch(master.id)
    slaveRuntime = await core.runtime.launch(slave.id)
  } catch (error) {
    fail(
      `no browser could be reached: ${error.message}\n` +
        '        this smoke test needs the Camoufox kernel (pnpm kernel:fetch) and a usable desktop ' +
        'session; set VFOX_SMOKE_HEADLESS=1 on a runner without one.',
    )
    throw new Error('browser launch failed')
  }
  step(`master pid ${masterRuntime.pid} at ${masterRuntime.wsEndpoint}`)
  step(`slave  pid ${slaveRuntime.pid} at ${slaveRuntime.wsEndpoint}`)

  // --- the slave reports whatever input it receives -------------------------------------------
  const received = []
  const slaveBrowser = await firefox.connect(slaveRuntime.wsEndpoint)
  openConnections.push(slaveBrowser)
  const slavePage = slaveBrowser.contexts()[0]?.pages()[0]
  if (!slavePage) {
    throw new Error('the slave browser exposed no page to observe')
  }
  await slavePage.exposeFunction('__vfoxSmokeRecord', payload => {
    received.push(payload)
  })
  await slavePage.evaluate(() => {
    const record = kind => event => {
      window.__vfoxSmokeRecord({
        kind,
        trusted: event.isTrusted,
        x: event.clientX,
        y: event.clientY,
        vw: window.innerWidth,
        vh: window.innerHeight,
      })
    }
    window.addEventListener('mousedown', record('mousedown'), true)
    window.addEventListener('mouseup', record('mouseup'), true)
    window.addEventListener('click', record('click'), true)
  })

  // --- the session under test ------------------------------------------------------------------
  sync = createSync({
    resolve: profileId => {
      const runtime = core.runtime.get(profileId)
      return { wsEndpoint: runtime.wsEndpoint, pid: runtime.pid, name: profileId }
    },
    logger,
  })

  step('starting a sync session (master -> slave)')
  const session = await sync.start({
    masterProfileId: master.id,
    slaveProfileIds: [slave.id],
  })
  if (!session.active || session.masterProfileId !== master.id) {
    throw new Error(`unexpected session: ${JSON.stringify(session)}`)
  }

  // --- click once in the master -----------------------------------------------------------------
  const masterBrowser = await firefox.connect(masterRuntime.wsEndpoint)
  openConnections.push(masterBrowser)
  const masterPage = masterBrowser.contexts()[0]?.pages()[0]
  if (!masterPage) {
    throw new Error('the master browser exposed no page to click in')
  }
  const masterViewport = await masterPage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const slaveViewport = await slavePage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  step(
    `master viewport ${masterViewport.width}x${masterViewport.height}, ` +
      `slave viewport ${slaveViewport.width}x${slaveViewport.height}`,
  )

  // --- WebGL availability: informational evidence, never a failure --------------------------------
  // Whether a GL context exists decides whether the engine's WebGL spoofing can be validated at
  // all, and it is the one thing about the fingerprint that needs a real browser to measure.
  const webgl = await masterPage.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) {
      return { available: false, webgl2: false }
    }
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      available: true,
      webgl2: Boolean(document.createElement('canvas').getContext('webgl2')),
      unmasked: Boolean(debug),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    }
  })
  step(`webgl probe (headless=${headless}): ${JSON.stringify(webgl)}`)
  if (!webgl.available) {
    log(
      'warn',
      'this browser exposed no WebGL context — WebGL spoofing cannot be measured in this run',
    )
  }

  const clickX = 120
  const clickY = 140
  step(`clicking once in the master at (${clickX}, ${clickY})`)
  await masterPage.bringToFront()
  await masterPage.mouse.click(clickX, clickY)

  await waitFor(() => received.some(entry => entry.kind === 'click'), 15_000, 'the slave to click')

  const clicks = received.filter(entry => entry.kind === 'click')
  const first = clicks[0]
  step(`slave received ${received.length} event(s): ${JSON.stringify(received)}`)

  if (!first) {
    throw new Error('the slave reported no click')
  }
  if (!first.trusted) {
    throw new Error('the replayed click was not trusted input')
  }

  const expectedX = Math.round((clickX * slaveViewport.width) / masterViewport.width)
  const expectedY = Math.round((clickY * slaveViewport.height) / masterViewport.height)
  if (Math.abs(first.x - expectedX) > 2 || Math.abs(first.y - expectedY) > 2) {
    throw new Error(
      `the slave click landed at (${first.x}, ${first.y}) but the viewport mapping expects ` +
        `(${expectedX}, ${expectedY})`,
    )
  }
  if (
    first.x < 0 ||
    first.y < 0 ||
    first.x >= slaveViewport.width ||
    first.y >= slaveViewport.height
  ) {
    throw new Error(`the slave click (${first.x}, ${first.y}) is outside its viewport`)
  }

  const mirrored = sync.current()?.mirroredEvents ?? 0
  if (mirrored <= 0) {
    throw new Error('the session reported no mirrored events')
  }
  step(`mirrored events: ${mirrored}`)

  // --- detaching must not close the user's windows ----------------------------------------------
  step('stopping the session and checking both windows survived the detach')
  await sync.stop()
  if (sync.current() !== null) {
    throw new Error('current() still reports a session after stop()')
  }
  await assertWindowStillOpen(master.id, core)
  await assertWindowStillOpen(slave.id, core)
  step('both windows are still running and still reachable')

  // --- tiling (needs real OS windows) ------------------------------------------------------------
  if (headless) {
    step('tiling skipped: headless profiles have no OS window')
  } else {
    try {
      await sync.tile({
        profileIds: [master.id, slave.id],
        layout: 'grid',
        displayIndex: null,
      })
      step('tiling: both windows moved into a grid')
    } catch (error) {
      const message = `tiling could not be verified here: ${error.message}`
      if (strictTile) {
        throw new Error(message)
      }
      log('warn', message)
    }
  }

  if (process.exitCode) {
    step('finished with failures')
  } else {
    step('PASS: master input was mirrored into the slave and the windows survived the detach')
  }
} catch (error) {
  if (!process.exitCode) {
    fail(error instanceof Error ? error.message : String(error))
  }
} finally {
  for (const browser of openConnections) {
    try {
      await browser.close()
    } catch {
      // The browser may already be gone; cleanup must not mask the real result.
    }
  }
  try {
    await sync?.close()
  } catch (error) {
    log('warn', `closing the synchroniser failed: ${error.message}`)
  }
  try {
    await core?.close()
  } catch (error) {
    log('warn', `closing the core failed: ${error.message}`)
  }
  try {
    await fs.rm(dataDir, { recursive: true, force: true })
  } catch (error) {
    log('warn', `removing ${dataDir} failed: ${error.message}`)
  }
}

process.exit(process.exitCode ?? 0)
