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
import { fileURLToPath } from 'node:url'
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

/** `152.0.4-beta.31` -> `{ version: '152.0.4', release: 'beta.31' }`, the shape version.json needs. */
function splitVersion(full) {
  const at = full.indexOf('-')
  return at === -1
    ? { version: full, release: '' }
    : { version: full.slice(0, at), release: full.slice(at + 1) }
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

async function headOk(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return response.ok ? Number(response.headers.get('content-length') ?? 0) : null
  } catch {
    return null
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(destination, bytes)
  return bytes.length
}

async function installFrom(url) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-camoufox-'))
  const archive = path.join(staging, 'engine.zip')
  try {
    const bytes = await download(url, archive)
    console.error(`[fetch-kernel] downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    // `extractZip` is `new AdmZip(file).extractAllTo(INSTALL_DIR, true)` — it holds no fetcher
    // state, so it works on a fetcher that never ran `init()`.
    const fetcher = new pkgman.CamoufoxFetcher()
    await fetcher.extractZip(archive)
    const { version, release } = splitVersion(ENGINE_VERSION)
    writeFileSync(
      path.join(installDir, 'version.json'),
      JSON.stringify({ version, release }),
      'utf8',
    )
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

/** Last resort: let camoufox-js resolve it, which needs api.github.com. */
async function installViaApi() {
  const fetcher = new pkgman.CamoufoxFetcher()
  await fetcher.init()
  if (fetcher.verstr !== ENGINE_VERSION) {
    throw new Error(`the registry resolved ${fetcher.verstr}, not the pinned ${ENGINE_VERSION}`)
  }
  const archive = await pkgman.CamoufoxFetcher.downloadFile(fetcher.url)
  pkgman.CamoufoxFetcher.cleanup()
  await fetcher.extractZip(archive)
  fetcher.setVersion()
}

const candidates = candidateUrls()
console.error(`[fetch-kernel] ${candidates.length} direct candidate URL(s); no API call needed`)
let installed = false
for (const url of candidates) {
  const size = await headOk(url)
  if (size === null) {
    console.error(`[fetch-kernel] miss: ${url}`)
    continue
  }
  console.error(`[fetch-kernel] hit (${(size / 1024 / 1024).toFixed(1)} MB): ${url}`)
  try {
    await installFrom(url)
    installed = true
    break
  } catch (error) {
    console.error(`[fetch-kernel] download/extract failed from ${url}: ${error.message}`)
  }
}

if (!installed) {
  console.error('[fetch-kernel] no direct URL worked; falling back to the GitHub API')
  try {
    await installViaApi()
    installed = true
  } catch (error) {
    console.error(
      `[fetch-kernel] API fallback failed too: ${error.message}\n` +
        '  If this is a rate limit, set VFOX_ENGINE_URL to a mirror of\n' +
        `  camoufox-${ENGINE_VERSION}-<os>.<arch>.zip, or download it in a browser and extract it\n` +
        `  into ${installDir}.`,
    )
    process.exit(1)
  }
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
