#!/usr/bin/env node
/**
 * verify-install.mjs — install the engine for real, from scratch, and prove it landed.
 *
 * This is the gate the project was missing. Two bugs reached a user on the very first thing a new
 * user does, and neither could be caught by a unit test, a typecheck or a build:
 *
 *   1. `ERR_STREAM_WRITE_AFTER_END` crashed the Electron main process at "100% · 469 MB / 470 MB".
 *      `camoufox-js`'s `webdl` writes fire-and-forget and never ends the sink, so its promise
 *      resolving did not mean the file had received everything; the code closed the file while
 *      writes were still in flight, and the resulting unhandled stream error bypassed try/catch.
 *   2. The GeoIP database was fetched through `api.github.com` (60 anonymous requests per hour per
 *      IP). Because that step ran *after* the engine install, a rate-limited lookup reported the
 *      whole install as failed while the engine was already correct.
 *
 * So this runs the application's own installer — `installCamoufoxEngine`, the exact function the
 * 一键安装 button calls — into an empty directory, with no engine cache to hide behind, and asserts
 * the result. It downloads ~490 MB, which is the point: the download is where the bugs were.
 *
 * The GeoIP step is allowed to fail (the database is optional and `fingerprint.geoip` is off by
 * default) but it is *reported*, so a silent regression there is still visible in the log.
 *
 * Usage:
 *   node packages/core/scripts/verify-install.mjs
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ENGINE_VERSION } from '@vfox/shared'
import { applyKernelDir, installCamoufoxEngine } from '../dist/kernel.js'
import { kernelLauncherName, kernelLayout } from '../dist/kernels.js'

const MMDB_FILE = 'GeoLite2-City.mmdb'

const fail = (stage, reason, hint) => {
  console.error(`VFOX_INSTALL_FAIL ${JSON.stringify({ stage, reason, hint: hint ?? null })}`)
  process.exit(1)
}

const target = mkdtempSync(path.join(os.tmpdir(), 'vfox-verify-install-'))
// With several kernels coexisting, a kernel build lands in <root>/kernels/<version>/ and the root keeps
// only the marker. This is the directory the installer must be told to write to.
const kernelTargetDir = path.join(kernelLayout(target).kernelsDir, ENGINE_VERSION)
// `applyKernelDir` must run before the first camoufox-js import, because the library resolves its
// install directory once at module load.
applyKernelDir(target)

console.error(`[install] target: ${target}`)
console.error(`[install] pinned engine: ${ENGINE_VERSION}`)

const phases = []
let lastPercent = -1
const started = Date.now()

try {
  await installCamoufoxEngine(
    progress => {
      if (!phases.includes(progress.phase)) phases.push(progress.phase)
      if (progress.phase === 'downloading' && typeof progress.percent === 'number') {
        const step = Math.floor(progress.percent / 25) * 25
        if (step > lastPercent) {
          lastPercent = step
          console.error(`[install] ${step}%`)
        }
      } else if (progress.message) {
        console.error(`[install] ${progress.phase}: ${progress.message}`)
      }
    },
    { version: ENGINE_VERSION, targetDir: kernelTargetDir },
  )
} catch (error) {
  // The bug this job exists for surfaced as an uncaught stream error rather than a rejection, so a
  // clean rejection here is already an improvement — but any rejection still fails the job.
  rmSync(target, { recursive: true, force: true })
  fail('install', error instanceof Error ? error.message : String(error), 'the installer rejected')
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)

/* -- the engine is really there ------------------------------------------------------------- */

// Since v0.4.0 a kernel build lives in <root>/kernels/<version>/ and the root carries only a
// version.json marker. This block used to assert the flat layout - camoufox.exe, properties.json and
// version.json all at the root - so it failed on a CORRECT install the moment the layout changed, and
// the CI step "Install the engine into an empty directory" went red for a reason that had nothing to
// do with installing anything. The resolution now goes through the same helpers the product uses, so
// the script cannot drift from the layout it is checking.
const layout = kernelLayout(target)
if (!existsSync(layout.markerFile)) {
  fail(
    'files',
    `version.json is missing at ${layout.root}`,
    'the marker is what stops a launch with no engine',
  )
}
const kernelDirs = existsSync(layout.kernelsDir)
  ? readdirSync(layout.kernelsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  : []
if (kernelDirs.length === 0) {
  fail(
    'files',
    `no kernel build under ${layout.kernelsDir}`,
    'the installer wrote the marker but no engine',
  )
}
const launcher = kernelLauncherName()
const kernelDir = path.join(layout.kernelsDir, kernelDirs[0])
for (const file of [launcher, 'properties.json', 'version.json']) {
  if (!existsSync(path.join(kernelDir, file))) {
    fail('files', `${file} is missing after the install`, `expected it in ${kernelDir}`)
  }
}

const version = JSON.parse(readFileSync(path.join(kernelDir, 'version.json'), 'utf8'))
const reported = `${version.version}-${version.release}`
if (reported !== ENGINE_VERSION) {
  fail(
    'version',
    `installed ${reported} but the pinned version is ${ENGINE_VERSION}`,
    'the resolver accepted a version it should have rejected',
  )
}

const files = statSync(path.join(kernelDir, launcher)).size
if (files <= 0) fail('files', `${launcher} is empty`, null)

/* -- the optional GeoIP step ---------------------------------------------------------------- */
const mmdb = path.join(target, MMDB_FILE)
const mmdbPresent = existsSync(mmdb)
const mmdbBytes = mmdbPresent ? statSync(mmdb).size : 0
if (mmdbPresent && mmdbBytes < 1_000_000) {
  fail('geoip', `${MMDB_FILE} is ${mmdbBytes} bytes — too small to be a database`, 'an error page?')
}

const installDirSize = (function walk(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? walk(full) : statSync(full).size
  }
  return total
})(target)

rmSync(target, { recursive: true, force: true })

console.log(
  `VFOX_INSTALL_OK ${JSON.stringify({
    engine: reported,
    seconds: Number(elapsed),
    phases,
    geoip: mmdbPresent ? { present: true, bytes: mmdbBytes } : { present: false, tolerated: true },
    bytes: installDirSize,
  })}`,
)
console.error(
  `[install] PASS in ${elapsed}s — engine installed, GeoIP ${mmdbPresent ? 'present' : 'skipped (optional)'}`,
)
