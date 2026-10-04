#!/usr/bin/env node
/**
 * fetch-kernel.mjs — install the PINNED Camoufox engine used by VFox.
 *
 * ## Why this does not call the GitHub API
 *
 * `camoufox-js` resolves the download through `https://api.github.com/repos/.../releases`, which is
 * rate-limited to **60 requests per hour per IP** for anonymous callers. A user behind a shared VPN
 * exit — the normal situation here — exhausts that immediately, and the app then reported
 * "Failed to fetch releases … after 5 attempts" while the very same release page opened fine in a
 * browser. The rate limit is on the *lookup*, not on the download: release assets are served from a
 * CDN and are not rate-limited at all.
 *
 * Because the engine is pinned, the asset URL is fully deterministic, so we build it and skip the
 * API entirely. The API remains as a last-resort fallback, and `VFOX_ENGINE_URL` overrides
 * everything for users who need a mirror.
 *
 * ## Why the version is pinned
 *
 * `camoufox fetch` always takes the newest release in range, which is how engine 156.0.1-beta.34
 * arrived and broke launching: it removed every `canvas:*` config key, so a profile's canvas hash
 * changed between launches and its stored identity could no longer be reproduced. Newest is not
 * best for a fingerprint browser.
 *
 * Usage:
 *   node scripts/fetch-kernel.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ENGINE_VERSION } from './engine-version.mjs'

const ENGINE_REPO = 'daijro/camoufox'

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
const verifying = process.argv.includes('--verify-url')
if (!verifying && already === ENGINE_VERSION && existsSync(path.join(installDir, 'camoufox.exe'))) {
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

/**
 * Candidate asset URLs, most specific first. The arch spelling is not obvious — camoufox-js's
 * `OS_ARCH_MATRIX` uses `x86_64` while Playwright-style tooling uses `x64` — so both are tried and
 * the winner is reported. A 404 on one candidate is not an error; a 404 on all of them is.
 */
function candidateUrls() {
  const urls = []
  const override = process.env.VFOX_ENGINE_URL?.trim()
  if (override) urls.push(override)

  const osName = pkgman.OS_NAME
  const platformArch = (() => {
    try {
      return pkgman.CamoufoxFetcher.getPlatformArch()
    } catch {
      return undefined
    }
  })()
  const arches = [...new Set([platformArch, 'x86_64', 'x64', 'arm64'].filter(Boolean))]

  for (const arch of arches) {
    urls.push(
      `https://github.com/${ENGINE_REPO}/releases/download/v${ENGINE_VERSION}/camoufox-${ENGINE_VERSION}-${osName}.${arch}.zip`,
    )
  }
  return urls
}

/** `null` when the URL does not resolve, otherwise its size in bytes. */
async function headOk(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return response.ok ? Number(response.headers.get('content-length') ?? 0) : null
  } catch {
    return null
  }
}
// `--verify-url` resolves the download URL and stops, without downloading 220 MB. It exists so CI
// can prove the direct CDN path still works even when the engine cache is warm and the fetch itself
// is skipped — otherwise a broken asset name would only surface the day the cache missed.
if (process.argv.includes('--verify-url')) {
  const candidates = candidateUrls()
  console.error(`[fetch-kernel] verifying ${candidates.length} candidate URL(s)`)
  for (const url of candidates) {
    const size = await headOk(url)
    if (size !== null) {
      console.error(`[fetch-kernel] OK  (${(size / 1024 / 1024).toFixed(1)} MB) ${url}`)
      console.log(url)
      process.exit(0)
    }
    console.error(`[fetch-kernel] miss ${url}`)
  }
  // Self-diagnosing failure: ask the API (which is authenticated in CI, so not rate-limited) what
  // the release actually contains, instead of making the next person guess asset names.
  console.error('[fetch-kernel] no direct URL resolved; asking the API what the release contains')
  try {
    const headers = process.env.GITHUB_TOKEN
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}
    const response = await fetch(
      `https://api.github.com/repos/${ENGINE_REPO}/releases/tags/v${ENGINE_VERSION}`,
      { headers },
    )
    console.error(`[fetch-kernel] API status for tag v${ENGINE_VERSION}: ${response.status}`)
    if (response.ok) {
      const release = await response.json()
      console.error(`[fetch-kernel] release tag: ${release.tag_name}`)
      for (const asset of release.assets ?? []) {
        console.error(`[fetch-kernel]   asset: ${asset.name}`)
      }
    } else {
      const releases = await fetch(
        `https://api.github.com/repos/${ENGINE_REPO}/releases?per_page=5`,
        { headers },
      )
      if (releases.ok) {
        const list = await releases.json()
        console.error('[fetch-kernel] recent tags:')
        for (const item of list) console.error(`[fetch-kernel]   ${item.tag_name}`)
      }
    }
  } catch (error) {
    console.error(`[fetch-kernel] could not query the API either: ${error.message}`)
  }
  process.exit(1)
}

/**
 * The install itself is the APPLICATION's own code path.
 *
 * This used to be a second implementation of the same download, which meant CI proved the script
 * while users ran `installCamoufoxEngine` in `packages/core` — two implementations, one of them
 * verified. That is the shape of bug that reaches production. Delegating here means the CI fetch
 * step exercises exactly the code a user's 一键安装 button runs.
 *
 * It requires `packages/core/dist` to exist, so the workflow builds the workspace before fetching.
 */
const coreKernel = path.join(repoRoot, 'packages', 'core', 'dist', 'kernel.js')
if (!existsSync(coreKernel)) {
  console.error(
    '[fetch-kernel] packages/core is not built. Run `pnpm --filter @vfox/core build` first — the\n' +
      '  install deliberately reuses the application code rather than a second copy of it.',
  )
  process.exit(1)
}

let installCamoufoxEngine
try {
  ;({ installCamoufoxEngine } = await import(pathToFileURL(coreKernel).href))
} catch (error) {
  console.error(`[fetch-kernel] cannot load the application installer: ${error.message}`)
  process.exit(1)
}

try {
  await installCamoufoxEngine(progress => {
    const detail = progress.message ? `: ${progress.message}` : ''
    console.error(`[fetch-kernel] ${progress.phase}${detail}`)
  })
} catch (error) {
  console.error(
    `[fetch-kernel] the application installer failed: ${error.message}\n` +
      '  Note the installer tries the CDN first and only falls back to api.github.com, so check the\n' +
      '  log above for which path it took before assuming a rate limit.',
  )
  process.exit(1)
}

const finalVersion = readInstalledVersion()
console.error(`[fetch-kernel] installed: ${finalVersion ?? 'unknown'}`)
if (finalVersion !== ENGINE_VERSION) {
  console.error(
    `[fetch-kernel] expected ${ENGINE_VERSION} after install but found ${finalVersion ?? 'nothing'}`,
  )
  process.exit(1)
}
if (!existsSync(path.join(installDir, 'camoufox.exe'))) {
  console.error('[fetch-kernel] camoufox.exe is missing after install')
  process.exit(1)
}

console.log(finalVersion)