#!/usr/bin/env node
/**
 * fetch-kernel.mjs — install the PINNED Camoufox engine used by VFox.
 *
 * Why this is not a bare `camoufox-js fetch`:
 *
 *   1. **The version is pinned.** `camoufox fetch` always takes the newest release in range, which
 *      is how engine 156.0.1-beta.34 arrived and broke launching: it removed every `canvas:*`
 *      config key, so a profile's canvas hash changed between launches and its stored identity
 *      could no longer be reproduced. The pinned version lives in
 *      `packages/shared/src/constants.ts` and is read here through `scripts/engine-version.mjs`.
 *   2. `CAMOUFOX_INSTALL_DIR` is pinned into the repo-local `.cache/camoufox` when unset, so
 *      `actions/cache`, `scripts/kernel-path.mjs` and the application agree on one path.
 *   3. It re-reads `version.json` afterwards and fails loudly if the engine is not actually there.
 *
 * The pin uses `CamoufoxFetcher.checkAsset`, the library's own extension point: it is handed every
 * release asset and returns the one to use. Overriding it to accept only the pinned
 * `Version.fullString` keeps the download, extraction and version bookkeeping inside camoufox-js —
 * we only say *which* release.
 *
 * `GITHUB_TOKEN` is honoured automatically by camoufox-js for api.github.com; CI passes
 * `${{ github.token }}` so the lookup is authenticated instead of sharing the anonymous budget.
 *
 * Usage:
 *   node scripts/fetch-kernel.mjs
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ENGINE_VERSION } from './engine-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDir = path.join(repoRoot, '.cache', 'camoufox')
const installDir = path.resolve(process.env.CAMOUFOX_INSTALL_DIR ?? defaultDir)
process.env.CAMOUFOX_INSTALL_DIR = installDir
mkdirSync(installDir, { recursive: true })

console.error(`[fetch-kernel] install dir: ${installDir}`)
console.error(`[fetch-kernel] pinned engine: ${ENGINE_VERSION}`)

const readInstalledVersion = () => {
  try {
    const raw = JSON.parse(readFileSync(path.join(installDir, 'version.json'), 'utf8'))
    return raw.version && raw.release ? `${raw.version}-${raw.release}` : null
  } catch {
    return null
  }
}

const already = readInstalledVersion()
if (already === ENGINE_VERSION && existsSync(path.join(installDir, 'camoufox.exe'))) {
  console.error(`[fetch-kernel] already installed: ${already}`)
  console.log(already)
  process.exit(0)
}
if (already && already !== ENGINE_VERSION) {
  console.error(`[fetch-kernel] replacing ${already} with the pinned ${ENGINE_VERSION}`)
}

let pkgman
try {
  pkgman = await import('camoufox-js/dist/pkgman.js')
} catch (error) {
  console.error(`[fetch-kernel] cannot load camoufox-js (${error.message}). Run \`pnpm install\`.`)
  process.exit(1)
}

let fetcher
try {
  /** Accept only the pinned release; every other asset is rejected and the library keeps looking. */
  class PinnedFetcher extends pkgman.CamoufoxFetcher {
    checkAsset(asset) {
      const found = super.checkAsset(asset)
      if (!found) return null
      const [version] = found
      return version.fullString === ENGINE_VERSION ? found : null
    }
  }
  fetcher = new PinnedFetcher()
  await fetcher.init()
} catch (error) {
  console.error(
    `[fetch-kernel] could not resolve the pinned engine ${ENGINE_VERSION}: ${error.message}\n` +
      '  This is the same GitHub release lookup `camoufox fetch` performs.\n' +
      '  Check network access to api.github.com and that GITHUB_TOKEN is set to avoid the\n' +
      '  unauthenticated rate limit. If the release was withdrawn, bump ENGINE_VERSION in\n' +
      '  packages/shared/src/constants.ts after checking the smoke test still passes on the new one.',
  )
  process.exit(1)
}

if (fetcher.verstr !== ENGINE_VERSION) {
  console.error(
    `[fetch-kernel] resolved ${fetcher.verstr} but ${ENGINE_VERSION} was pinned — refusing to continue`,
  )
  process.exit(1)
}

try {
  const archive = await pkgman.CamoufoxFetcher.downloadFile(fetcher.url)
  pkgman.CamoufoxFetcher.cleanup()
  await fetcher.extractZip(archive)
  fetcher.setVersion()
} catch (error) {
  console.error(`[fetch-kernel] install failed: ${error.message}`)
  process.exit(1)
}

const installed = readInstalledVersion()
console.error(`[fetch-kernel] installed: ${installed ?? 'unknown'}`)
if (installed !== ENGINE_VERSION) {
  console.error(
    `[fetch-kernel] expected ${ENGINE_VERSION} after install but found ${installed ?? 'nothing'}`,
  )
  process.exit(1)
}
if (!existsSync(path.join(installDir, 'camoufox.exe'))) {
  console.error('[fetch-kernel] camoufox.exe is missing after install')
  process.exit(1)
}

console.log(installed)
