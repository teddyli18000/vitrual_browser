/**
 * VFox engine smoke test — CI-only.
 *
 * Launches TWO real profiles through the real `@vfox/core` API, reads the fingerprint each engine
 * actually presents, and fails unless the two profiles are genuinely different. This is the only
 * test that proves the product does what it claims: a window opens, the engine spoofs, and two
 * profiles are not the same machine.
 *
 * It cannot run inside the DSH workspace sandbox: the sandbox denies piped stdio, and Playwright
 * must pipe stdio to speak Juggler to the engine (`spawn EPERM`). Run it in CI or any unconfined
 * shell.
 *
 * Prerequisites: `pnpm install`, the engine (`pnpm kernel:fetch`), and a build of this package
 * (`pnpm --filter @vfox/core build`) because the script imports the compiled `../dist`.
 *
 * Output contract (do not change without updating `.github/workflows/ci.yml`):
 *   stdout, one line per event, nothing else:
 *     VFOX_SMOKE_ENGINE {"path":…,"version":…}
 *     VFOX_SMOKE_PROFILE {"index":1,"os":"windows","userAgent":…,…}
 *     VFOX_SMOKE_OK {"headless":…,"profiles":[…],"compared":[…],"distinct":[…],
 *                    "distinctCount":N,"requiredDistinct":4}
 *   stderr: human-readable progress, `VFOX_SMOKE_WARN …`, and on failure
 *     VFOX_SMOKE_FAIL {"stage":…,"reason":…,"hint":…}
 *   exit code: 0 ok | 1 spoofing/assertion failure | 2 engine missing or could not be launched
 *
 * Env:
 *   VFOX_SMOKE_HEADLESS=1|true|yes|on   run headless (GitHub runners have no interactive desktop)
 *   CAMOUFOX_INSTALL_DIR                optional; honoured by camoufox-js when set
 *   VFOX_DATA_DIR                       not used — a private temp directory is always used
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { firefox } from 'playwright-core'

const REQUIRED_DISTINCT = 4
const DIMENSIONS = [
  'userAgent',
  'platform',
  'hardwareConcurrency',
  'languages',
  'timezone',
  'screen',
  'webgl',
  'canvasHash',
]

const headless = /^(1|true|yes|on)$/i.test(process.env.VFOX_SMOKE_HEADLESS ?? '')

class SmokeFailure extends Error {
  constructor(stage, reason, exitCode, hint) {
    super(reason)
    this.stage = stage
    this.exitCode = exitCode
    this.hint = hint
  }
}

function log(message) {
  process.stderr.write(`[smoke] ${message}\n`)
}

function emit(marker, payload, stream = process.stdout) {
  stream.write(`${marker} ${JSON.stringify(payload)}\n`)
}

function fail(stage, reason, exitCode, hint) {
  throw new SmokeFailure(stage, reason, exitCode, hint)
}

/** One comparable value per dimension; WebGL is vendor+renderer together. */
function dimensionValue(values, dimension) {
  if (dimension === 'webgl') {
    return `${values.webglVendor ?? ''}|${values.webglRenderer ?? ''}`
  }
  return String(values[dimension])
}

const FINGERPRINT_SCRIPT = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 220
  canvas.height = 60
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.textBaseline = 'top'
    ctx.font = '16px "Arial"'
    ctx.fillStyle = '#f60'
    ctx.fillRect(0, 0, 120, 30)
    ctx.fillStyle = '#069'
    ctx.fillText('VFox fingerprint probe', 2, 12)
  }
  const dataUrl = canvas.toDataURL()

  let webglVendor = null
  let webglRenderer = null
  const gl = canvas.getContext('webgl')
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (debugInfo) {
      webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    } else {
      webglVendor = gl.getParameter(gl.VENDOR)
      webglRenderer = gl.getParameter(gl.RENDERER)
    }
  }

  // FNV-1a over the data URL: enough to tell two canvases apart, no crypto needed.
  let hash = 0x811c9dc5
  for (let i = 0; i < dataUrl.length; i += 1) {
    hash ^= dataUrl.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    languages: (navigator.languages ?? []).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
    webglVendor: webglVendor ? String(webglVendor) : null,
    webglRenderer: webglRenderer ? String(webglRenderer) : null,
    canvasHash: hash.toString(16),
  }
}

/** Read the fingerprint the engine actually presents, through the profile's wsEndpoint. */
async function readFingerprint(wsEndpoint) {
  const browser = await firefox.connect(wsEndpoint)
  try {
    const context = browser.contexts()[0]
    if (!context) {
      throw new Error('the engine exposed no browser context')
    }
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('about:blank')
    return await page.evaluate(FINGERPRINT_SCRIPT)
  } finally {
    // A connected browser's close() only drops the connection; `_sharedBrowser` keeps the
    // profile window alive.
    await browser.close()
  }
}

/** PIDs of engine processes still holding this run's data directory. `null` if unavailable. */
function orphanPids(dataDir) {
  if (process.platform !== 'win32') {
    return null
  }
  const command = [
    'Get-CimInstance Win32_Process -Filter "Name=\'camoufox.exe\'"',
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dataDir}') }`,
    'Select-Object -ExpandProperty ProcessId',
  ].join(' | ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    return null
  }
  return result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger)
}

const PROFILE_INPUTS = [
  {
    label: 'windows-desktop',
    input: {
      name: 'smoke-windows',
      fingerprint: {
        os: 'windows',
        // Deterministic fingerprints: no GeoIP lookup, so CI needs no network beyond the engine.
        geoip: false,
        screen: { minWidth: 1280, maxWidth: 1920, minHeight: 800, maxHeight: 1080 },
      },
      launch: { headless },
    },
  },
  {
    label: 'macos-window',
    input: {
      name: 'smoke-macos',
      fingerprint: {
        os: 'macos',
        geoip: false,
        screen: { minWidth: 1440, maxWidth: 2560, minHeight: 900, maxHeight: 1440 },
        window: { width: 1600, height: 1000 },
      },
      launch: { headless },
    },
  },
]

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-smoke-'))
log(`data dir: ${dataDir}`)
log(`headless: ${headless}`)

let core = null
let failure = null

try {
  let createCore
  try {
    ;({ createCore } = await import('../dist/index.js'))
  } catch (error) {
    fail(
      'build-missing',
      `could not import ../dist/index.js: ${error instanceof Error ? error.message : String(error)}`,
      2,
      'run `pnpm --filter @vfox/core build` before this script',
    )
  }

  core = await createCore({ dataDir })

  const kernel = await core.kernel.info()
  emit('VFOX_SMOKE_ENGINE', { path: kernel.path, version: kernel.version })
  if (!kernel.installed) {
    fail(
      'engine-missing',
      'the Camoufox engine is not installed',
      2,
      'run `pnpm kernel:fetch`, and export the same CAMOUFOX_INSTALL_DIR for this step',
    )
  }
  log(`engine: ${kernel.version} at ${kernel.path}`)

  const results = []
  for (const [index, entry] of PROFILE_INPUTS.entries()) {
    const profile = await core.profiles.create(entry.input)
    log(`launching ${entry.label} (${profile.id})`)

    let runtime
    try {
      runtime = await core.runtime.launch(profile.id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fail(
        'launch',
        `${entry.label} did not launch: ${reason}`,
        2,
        /EPERM/.test(reason)
          ? 'the shell is sandboxed and cannot pipe stdio, which the engine requires'
          : 'check the engine install and the profile fingerprint',
      )
    }
    if (runtime.status !== 'running' || !runtime.wsEndpoint) {
      fail('launch', `${entry.label} reported ${runtime.status} without a wsEndpoint`, 2)
    }
    log(`  pid ${runtime.pid}, wsEndpoint ${runtime.wsEndpoint}`)

    const values = await readFingerprint(runtime.wsEndpoint)
    const evidence = { index: index + 1, os: entry.input.fingerprint.os, ...values }
    results.push(evidence)
    emit('VFOX_SMOKE_PROFILE', evidence)
  }

  for (const profile of await core.profiles.list()) {
    const stopped = await core.runtime.stop(profile.id)
    log(`stopped ${profile.id}: ${stopped.status}`)
  }

  const leftovers = orphanPids(dataDir)
  if (leftovers === null) {
    emit(
      'VFOX_SMOKE_WARN',
      { stage: 'orphan', reason: 'could not enumerate engine processes on this platform' },
      process.stderr,
    )
  } else if (leftovers.length > 0) {
    fail(
      'orphan',
      `${leftovers.length} engine process(es) survived stop: ${leftovers.join(', ')}`,
      1,
    )
  } else {
    log('orphan check: no engine process left behind')
  }

  const [first, second] = results
  const distinct = DIMENSIONS.filter(
    dimension => dimensionValue(first, dimension) !== dimensionValue(second, dimension),
  )

  for (const dimension of DIMENSIONS) {
    log(
      `  ${dimension}: ${dimensionValue(first, dimension)} | ${dimensionValue(second, dimension)}`,
    )
  }
  log(`compared ${DIMENSIONS.length} dimensions, ${distinct.length} differ: ${distinct.join(', ')}`)

  if (distinct.length < REQUIRED_DISTINCT) {
    fail(
      'fingerprint',
      `only ${distinct.length}/${DIMENSIONS.length} fingerprint dimensions differ between two profiles (need ${REQUIRED_DISTINCT})`,
      1,
      "the engine is not spoofing per profile — this is the product's core promise",
    )
  }

  emit('VFOX_SMOKE_OK', {
    headless,
    profiles: results,
    compared: DIMENSIONS,
    distinct,
    distinctCount: distinct.length,
    requiredDistinct: REQUIRED_DISTINCT,
  })
  log('smoke test passed')
} catch (error) {
  failure =
    error instanceof SmokeFailure
      ? error
      : new SmokeFailure(
          'unexpected',
          error instanceof Error ? error.message : String(error),
          1,
          undefined,
        )
} finally {
  if (core) {
    await core.close().catch(() => {})
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

if (failure) {
  emit(
    'VFOX_SMOKE_FAIL',
    {
      stage: failure.stage,
      reason: failure.message,
      hint: failure.hint ?? null,
    },
    process.stderr,
  )
  log(`FAILED at ${failure.stage}: ${failure.message}`)
  if (failure.hint) {
    log(`hint: ${failure.hint}`)
  }
  process.exit(failure.exitCode)
}
