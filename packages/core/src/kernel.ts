/**
 * Camoufox engine ("kernel") management: where it is, what version it is, and installing it.
 *
 * `install()` mirrors what `pnpm kernel:fetch` does — engine, GeoIP database and default addons —
 * because the desktop app and the CLI both call it on first run instead of shelling out to the CLI.
 * Progress is real: bytes are counted while camoufox-js streams the download, so `percent` is only
 * reported when a total size is actually known and stays `null` otherwise.
 */

import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { Worker } from 'node:worker_threads'
import type { KernelInfo, KernelPhase, KernelProgress } from '@vfox/shared'
import { ENGINE_VERSION, ENGINE_VERSIONS } from '@vfox/shared'
import { camoufoxModule } from './camoufox.js'
import type { CoreLogger } from './index.js'
// TYPE-ONLY, and it must stay that way: a value import would execute the worker script in the main
// process, where `workerData` is null and the extraction would throw at import time.
import type { UnzipWorkerData, UnzipWorkerMessage } from './unzip-worker.js'

export type KernelProgressListener = (progress: KernelProgress) => void

/** A phase report with only the fields the reporter actually knows; the manager completes it. */
export type ProgressReporter = (progress: Partial<KernelProgress> & { phase: KernelPhase }) => void

/** The install work itself, injectable so tests never touch the network. */
export type EngineInstaller = (emit: ProgressReporter) => Promise<void>

export interface KernelManagerOptions {
  kernelDir?: string
  logger: CoreLogger
  installer?: EngineInstaller
}

const LAUNCH_FILE = 'camoufox.exe'
const VERSION_FILE = 'version.json'
const MMDB_FILE = 'GeoLite2-City.mmdb'
/** Download (~550 MB) + extracted engine (~1 GB) + staging copy, with headroom. */
const REQUIRED_FREE_BYTES = 3 * 1024 ** 3

/**
 * Point camoufox-js at `kernelDir`.
 *
 * camoufox-js resolves its install directory once, at module load, from `CAMOUFOX_INSTALL_DIR`,
 * so this has to run before the first camoufox-js import — hence a separate call rather than a
 * lazy lookup.
 */
export function applyKernelDir(kernelDir?: string): void {
  if (kernelDir) {
    process.env.CAMOUFOX_INSTALL_DIR = path.resolve(kernelDir)
  }
}

export class KernelManager {
  readonly #options: KernelManagerOptions
  readonly #listeners = new Set<KernelProgressListener>()
  #installing: Promise<KernelInfo> | null = null

  constructor(options: KernelManagerOptions) {
    this.#options = options
  }

  async info(): Promise<KernelInfo> {
    const dir = await resolveEngineDir()
    if (!(await exists(path.join(dir, LAUNCH_FILE)))) {
      return { installed: false, version: null, path: null, source: 'missing' }
    }

    let version: string | null = null
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, VERSION_FILE), 'utf8')) as {
        version?: unknown
        release?: unknown
      }
      version = typeof raw.version === 'string' ? `${raw.version}-${String(raw.release)}` : null
    } catch {
      this.#options.logger.warn(
        `engine found at ${dir} but ${VERSION_FILE} is missing or unreadable; launching will fail`,
      )
    }
    return { installed: true, version, path: dir, source: 'cache' }
  }

  install(): Promise<KernelInfo> {
    // Two concurrent installs would download the engine twice.
    this.#installing ??= this.#runInstall().finally(() => {
      this.#installing = null
    })
    return this.#installing
  }

  on(_event: 'progress', listener: KernelProgressListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async #runInstall(): Promise<KernelInfo> {
    // A user-supplied engine directory is honoured, but it is validated first: pointing VFox at a
    // folder that holds something else must not silently fill it with a 1 GB browser.
    const dir = await resolveEngineDir()
    if (await looksLikeSomethingElse(dir)) {
      this.#options.logger.warn(
        `the configured engine directory ${dir} exists but contains no ${LAUNCH_FILE}; ` +
          'installing the Camoufox engine into it',
      )
    }

    this.#emit({ phase: 'checking', message: 'Checking the latest Camoufox release' })
    try {
      await (this.#options.installer ?? installCamoufoxEngine)(progress => this.#emit(progress))
    } catch (error) {
      this.#emit({ phase: 'error', message: errorMessage(error) })
      throw error
    }
    const info = await this.info()
    this.#emit({
      phase: 'done',
      percent: 100,
      message: info.installed
        ? `Camoufox ${info.version ?? '(unknown version)'} is ready`
        : 'Camoufox is still not installed after the download',
    })
    return info
  }

  #emit(progress: Partial<KernelProgress> & { phase: KernelPhase }): void {
    const full = complete(progress)
    for (const listener of this.#listeners) {
      try {
        listener(full)
      } catch (error) {
        this.#options.logger.warn(`kernel progress listener failed: ${errorMessage(error)}`)
      }
    }
  }
}

function complete(progress: Partial<KernelProgress> & { phase: KernelPhase }): KernelProgress {
  return {
    phase: progress.phase,
    percent: progress.percent ?? null,
    receivedBytes: progress.receivedBytes ?? null,
    totalBytes: progress.totalBytes ?? null,
    message: progress.message ?? null,
  }
}

/**
 * The real installer: camoufox-js's own download/extract primitives, driven so that byte progress
 * and the download/extract boundary are observable. The staged zip is downloaded *before* the
 * existing engine is removed, so a failed download never leaves the user without an engine.
 */
/** The upstream repository the pinned engine comes from. */
const ENGINE_REPO = 'daijro/camoufox'

/** `152.0.4-beta.31` -> `{ version: '152.0.4', release: 'beta.31' }`, the shape version.json needs. */
function splitEngineVersion(full: string): { version: string; release: string } {
  const at = full.indexOf('-')
  return at === -1
    ? { version: full, release: '' }
    : { version: full.slice(0, at), release: full.slice(at + 1) }
}

/**
 * Resolve the engine download URL, preferring a plain CDN URL over `api.github.com`.
 *
 * `camoufox-js` resolves through the API, which allows 60 anonymous requests per hour per IP — a
 * shared VPN exit exhausts that immediately, and the app then reports "Failed to fetch releases …
 * after 5 attempts" while the same release page opens fine in a browser. The asset URL is
 * deterministic because the engine is pinned, so it is built here and only verified with a HEAD
 * request; the API is the fallback, and `VFOX_ENGINE_URL` overrides both for mirrors.
 *
 * The arch spelling is not obvious — camoufox-js's `OS_ARCH_MATRIX` says `x86_64` while
 * Playwright-style tooling says `x64` — so both are tried and the winner is logged.
 */
async function resolveEngineUrl(
  pkgman: { OS_NAME: string; CamoufoxFetcher: { getPlatformArch?: () => string } },
  emit: ProgressReporter,
): Promise<string> {
  const override = process.env.VFOX_ENGINE_URL?.trim()
  const candidates: string[] = []

  if (override) {
    candidates.push(override)
  } else {
    const platformArch = (() => {
      try {
        return pkgman.CamoufoxFetcher.getPlatformArch?.()
      } catch {
        return undefined
      }
    })()
    const arches = [...new Set([platformArch, 'x86_64', 'x64', 'arm64'].filter(Boolean))]
    // Every acceptable version, most preferred first. A single pin is a single point of failure:
    // upstream withdrew the version this project was pinned to, every URL 404ed, the API fallback
    // resolved an engine with no canvas keys, the safety check rejected it, and the install button
    // simply refused to install anything. Walking the list keeps canvas spoofing AND survives a
    // withdrawal.
    for (const version of ENGINE_VERSIONS) {
      for (const arch of arches) {
        candidates.push(
          `https://github.com/${ENGINE_REPO}/releases/download/v${version}/camoufox-${version}-${pkgman.OS_NAME}.${String(arch)}.zip`,
        )
      }
    }
  }

  emit({ phase: 'checking', message: `Resolving Camoufox ${ENGINE_VERSION}` })
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      if (response.ok) {
        emit({ phase: 'downloading', message: `Downloading Camoufox ${ENGINE_VERSION}` })
        return url
      }
    } catch {
      // Try the next candidate; a miss here is not an error until every candidate has failed.
    }
  }

  emit({ phase: 'checking', message: 'Falling back to the GitHub API to resolve the engine' })
  const { CamoufoxFetcher } = (await import(
    camoufoxModule('dist/pkgman.js')
  )) as typeof import('camoufox-js/dist/pkgman.js')
  const fetcher = new CamoufoxFetcher()
  await fetcher.init()
  if (!(ENGINE_VERSIONS as readonly string[]).includes(fetcher.verstr)) {
    throw new Error(
      `the engine registry resolved ${fetcher.verstr}, which is not one of the versions this build ` +
        `was tested against (${ENGINE_VERSIONS.join(', ')}); refusing to install it. Set ` +
        'VFOX_ENGINE_URL to a mirror of a tested build, or update ENGINE_VERSIONS in ' +
        'packages/shared/src/constants.ts after checking the smoke test passes on the new one.',
    )
  }
  return fetcher.url
}
export const installCamoufoxEngine: EngineInstaller = async emit => {
  // The specifier is dynamic, so the type has to be named explicitly.
  const pkgman = (await import(
    camoufoxModule('dist/pkgman.js')
  )) as typeof import('camoufox-js/dist/pkgman.js')
  const { DefaultAddons, maybeDownloadAddons } = await import(camoufoxModule('dist/addons.js'))

  const target = pkgman.INSTALL_DIR.toString()

  // The engine is PINNED, not "newest". `camoufox fetch` always takes the latest release in range,
  // which is how 156.0.1-beta.34 arrived and broke launching: it dropped every `canvas:*` config key
  // (82 properties, none of them canvas), so a profile's canvas hash changed between launches and
  // the stored identity could no longer be reproduced. Newest is not best for a fingerprint browser.
  // `checkAsset` is camoufox-js's own extension point — it is handed each release asset and returns
  // the one to use — so overriding it keeps the download, extraction and version bookkeeping inside
  // the library and only changes *which* release we ask for.
  class PinnedFetcher extends pkgman.CamoufoxFetcher {
    override checkAsset(asset: unknown) {
      const found = super.checkAsset(asset)
      if (!found) return null
      const [version] = found
      return version.fullString === ENGINE_VERSION ? found : null
    }
  }

  const fetcher = new PinnedFetcher()
  // Resolve the download URL WITHOUT api.github.com where we can. That endpoint allows 60
  // anonymous requests per hour per IP, and a user behind a shared VPN exit exhausts it at once —
  // observed as "Failed to fetch releases … after 5 attempts" while the same release page opened
  // fine in a browser. The limit is on the *lookup*, not the download: release assets come from a
  // CDN. The asset URL is deterministic because the engine is pinned, so we build it and only fall
  // back to the API when every candidate 404s. VFOX_ENGINE_URL overrides both, for mirrors.
  const url = await resolveEngineUrl(pkgman, emit)
  fetcher._url = url

  let current: string | null = null
  try {
    current = pkgman.installedVerStr()
  } catch {
    current = null
  }

  if (current !== ENGINE_VERSION || !(await exists(path.join(target, LAUNCH_FILE)))) {
    // The archive is staged in `os.tmpdir()` and only then extracted into `target`, so on the
    // common small-system-drive layout the engine volume passes this check while the staging volume
    // fills up — and ENOSPC during the download is the crash path. Both volumes are checked.
    await requireFreeSpace(target)
    await requireFreeSpace(os.tmpdir())
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-camoufox-'))
    try {
      const archive = await downloadEngine(url, ENGINE_VERSION, staging, emit)
      emit({ phase: 'extracting', message: `Extracting Camoufox ${ENGINE_VERSION}` })
      // Extract beside the target and swap directories in, rather than deleting the old engine
      // first. Destructive-first is what made a failed *extraction* cost the user their working
      // engine — reachable through a truncated archive, ENOSPC (extraction is when disk usage peaks:
      // the archive is still staged while ~1 GB is written) or a crash mid-extract.
      await swapInEngine({
        archive,
        target,
        extract: (from, into) =>
          extractArchive(from, into, (fraction, bytes) =>
            emit({
              phase: 'extracting',
              message: `Extracting Camoufox ${ENGINE_VERSION} — ${Math.round(bytes / 1048576)} MB`,
              percent: Math.round(fraction * 100),
            }),
          ),
        warn: message => emit({ phase: 'extracting', message }),
      })
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  if (!(await exists(path.join(target, MMDB_FILE)))) {
    emit({ phase: 'downloading', message: 'Downloading the GeoIP database' })
    await downloadGeoIpDatabase(target, emit)
  }
  await maybeDownloadAddons(DefaultAddons)
}

/**
 * Fetch the GeoIP database, and **never fail the install because of it**.
 *
 * Two separate defects lived here. The database was downloaded through
 * `api.github.com/repos/P3TERX/GeoLite.mmdb/releases`, which is rate-limited to 60 anonymous
 * requests per hour per IP — so a user behind a shared VPN exit hit the same wall as the engine
 * download. And because the call sat *after* the engine install, the resulting throw reported
 * "安装失败" while the engine was already correctly in place, which is both wrong and confusing.
 *
 * The database is optional: it is only consulted when `fingerprint.geoip` is enabled, which is off
 * by default. So the direct CDN URL is tried first, camoufox-js's API path second, and a total
 * failure is a warning rather than an error.
 */
async function downloadGeoIpDatabase(target: string, emit: ProgressReporter): Promise<void> {
  // One directory source. `resolveEngineDir()` re-reads the env var on every call while the install
  // uses the frozen `pkgman.INSTALL_DIR`; mixing them means the database can be written to one
  // directory while the caller checks the other, so it re-downloads on every install. The caller
  // already knows which directory this install is using, so it is passed in.
  const destination = path.join(target, MMDB_FILE)
  // `/releases/latest/download/<asset>` redirects straight to the newest asset, so it needs no API
  // call and no pinned tag — the upstream tag is a date that changes every day.
  const direct =
    process.env.VFOX_MMDB_URL?.trim() ||
    'https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb'

  try {
    const response = await fetch(direct, { redirect: 'follow' })
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer())
      // A GeoIP database is tens of megabytes; anything tiny is an error page, not the database.
      if (bytes.length > 1_000_000) {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, bytes)
        emit({
          phase: 'downloading',
          message: `GeoIP database ready (${formatBytes(bytes.length)})`,
        })
        return
      }
    }
  } catch {
    // Fall through to the library's own path.
  }

  try {
    const { downloadMMDB } = await import(camoufoxModule('dist/locale.js'))
    await downloadMMDB()
    return
  } catch (error) {
    emit({
      phase: 'downloading',
      message:
        `GeoIP database unavailable (${error instanceof Error ? error.message : String(error)}). Continuing — it is only used when a ` +
        'profile enables fingerprint.geoip.',
    })
  }
}

export interface EngineSwapOptions {
  archive: string
  target: string
  /** Extraction is injected so a test can fail it without a 490 MB archive. */
  extract: (archive: string, into: string) => Promise<void>
  warn?: (message: string) => void
}

/**
 * Extract into `<target>.new`, then swap it into place.
 *
 * Sequence, and exactly what happens at each failure point:
 *
 *  1. extract into `<target>.new` — a *sibling* of the target, so the renames below never cross a
 *     volume. Fails → `.new` is removed and `target` is untouched, so the user keeps the engine they
 *     already had. This is the case the old destructive-first order got wrong.
 *  2. rename `target` → `<target>.old`. Fails → `.new` is removed, `target` untouched.
 *  3. rename `<target>.new` → `target`. Fails → `.old` is renamed back and `.new` removed, so the
 *     user is never left with neither engine.
 *  4. remove `<target>.old`. Fails → warned about only: the new engine is already in place, so a
 *     leftover `.old` is cosmetic rather than fatal.
 */
export async function swapInEngine({
  archive,
  target,
  extract,
  warn,
}: EngineSwapOptions): Promise<void> {
  const incoming = `${target}.new`
  const previous = `${target}.old`

  await fs.rm(incoming, { recursive: true, force: true })
  await fs.mkdir(incoming, { recursive: true })
  try {
    await extract(archive, incoming)
  } catch (error) {
    await fs.rm(incoming, { recursive: true, force: true })
    throw error
  }

  await fs.rm(previous, { recursive: true, force: true })
  const hadPrevious = await exists(target)
  if (hadPrevious) {
    await fs.rename(target, previous)
  }
  try {
    await fs.rename(incoming, target)
  } catch (error) {
    if (hadPrevious) {
      await fs.rename(previous, target).catch(restoreError => {
        warn?.(`could not restore ${target} from ${previous}: ${errorMessage(restoreError)}`)
      })
    }
    await fs.rm(incoming, { recursive: true, force: true })
    throw error
  }
  await fs.rm(previous, { recursive: true, force: true }).catch(error => {
    warn?.(`the previous engine is still at ${previous}: ${errorMessage(error)}`)
  })
}

/**
 * Extract an engine archive into `into`, **off the main thread**, then write the version marker that
 * makes the result launchable.
 *
 * The extraction runs in a `worker_threads` worker — see `src/unzip-worker.ts` for the measurement
 * behind that. In the desktop app the installer runs in the Electron main process, and a synchronous
 * ~1 GB extraction there is ~20 seconds of a frozen window (Windows: "not responding"). Moving it out
 * keeps the UI painting and lets the progress bar advance, which is why the worker reports per entry.
 */
async function extractArchive(
  archive: string,
  into: string,
  onProgress: (fraction: number, bytes: number) => void,
): Promise<void> {
  const worker = new Worker(new URL('./unzip-worker.js', import.meta.url), {
    workerData: {
      archive,
      into,
      desc: `Extracting Camoufox ${ENGINE_VERSION}`,
    } satisfies UnzipWorkerData,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on('message', (message: UnzipWorkerMessage) => {
        if (message.type === 'progress') {
          onProgress(message.total === 0 ? 1 : message.done / message.total, message.bytes)
        } else if (message.type === 'done') {
          resolve()
        } else {
          reject(new Error(`extracting the engine archive failed: ${message.message}`))
        }
      })
      worker.on('error', reject)
      worker.on('exit', code => {
        if (code !== 0) {
          reject(new Error(`the extraction worker exited with code ${code}`))
        }
      })
    })
  } finally {
    await worker.terminate()
  }
  // version.json is what `installedVerStr()` reads; the fetcher's own `setVersion()` writes it into
  // the frozen `INSTALL_DIR`, so the same shape is written here, into the directory being prepared.
  await fs.writeFile(
    path.join(into, 'version.json'),
    JSON.stringify(splitEngineVersion(ENGINE_VERSION)),
    'utf8',
  )
  if (process.platform !== 'win32') {
    execFileSync('chmod', ['-R', '755', into])
  }
}

/** Stream the engine archive into `staging` and return its path, reporting real byte counts. */
async function downloadEngine(
  url: string,
  version: string,
  staging: string,
  emit: ProgressReporter,
): Promise<string> {
  const { webdl } = await import(camoufoxModule('dist/pkgman.js'))
  const archive = path.join(staging, 'camoufox.zip')
  const total = await contentLength(url)
  let received = 0

  const file = createWriteStream(archive)

  // A WriteStream 'error' is emitted asynchronously, outside any promise chain, so it would bypass
  // the try/catch below and reach the process as an uncaught exception. That is exactly how a
  // completed download crashed the Electron main process with a fatal dialog. Capture it instead
  // and let the caller report a failed install.
  let streamError: Error | null = null
  file.on('error', error => {
    streamError ??= error
  })

  // `webdl` is fire-and-forget: it calls `buffer.write(chunk)` and never awaits it, never ends the
  // sink, and returns as soon as the response body is exhausted (see its `for await` loop). So its
  // promise resolving does NOT mean the file has received everything, and closing the file at that
  // point is what produced `ERR_STREAM_WRITE_AFTER_END` at "100% · 469 MB / 470 MB" — an unhandled
  // stream error that reached the Electron main process as a fatal dialog.
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      emit({
        phase: 'downloading',
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        receivedBytes: received,
        totalBytes: total,
        message: `Downloading Camoufox ${version}`,
      })
      // The stream's write completes only when the file write does, which is what makes `end()`
      // below a real flush rather than a race.
      file.write(chunk, callback)
    },
  })

  // The write error surfaces on the SINK, not on `file`: the sink's write callback *is*
  // `file.write`'s callback, so a failing write rejects the sink's write and the Writable emits
  // 'error'. Node throws for an unhandled 'error' event, which bypasses `sink.end()`'s callback,
  // the catch below and every check inside it — producing exactly the fatal dialog this drain logic
  // was added to remove, just triggered by ENOSPC instead of a race. Found by adversarial review and
  // reproduced as an uncaught ENOSPC with the listener missing.
  sink.on('error', error => {
    streamError ??= error
  })

  emit({
    phase: 'downloading',
    percent: 0,
    receivedBytes: 0,
    totalBytes: total,
    message: `Downloading Camoufox ${version}`,
  })

  try {
    await webdl(url, '', false, sink)
    // End it ourselves: `end()`'s callback fires on 'finish', which is only after every queued
    // write has completed. Without this the file is closed while writes are still in flight.
    await new Promise<void>((resolve, reject) => {
      sink.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
    if (streamError) throw streamError
    await new Promise<void>((resolve, reject) => {
      file.close(error => (error ? reject(error) : resolve()))
    })
    if (received === 0) {
      throw new Error(`the engine download produced no data (${url})`)
    }
    if (total !== null && received < total) {
      throw new Error(
        `the engine download is incomplete: ${received} of ${total} bytes (${url}). ` +
          'Retry, or set VFOX_ENGINE_URL to a mirror.',
      )
    }
  } catch (error) {
    if (!sink.writableEnded) {
      await new Promise<void>(resolve => sink.end(() => resolve()))
    }
    if (!file.closed) {
      await new Promise<void>(resolve => file.close(() => resolve()))
    }
    throw streamError ?? error
  }
  return archive
}

/** Total size of a download, or `null` when the server does not tell us (never guessed). */
async function contentLength(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!response.ok) {
      return null
    }
    const header = response.headers.get('content-length')
    const parsed = header ? Number.parseInt(header, 10) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export async function resolveEngineDir(): Promise<string> {
  // `CAMOUFOX_INSTALL_DIR` is the documented switch (see `applyKernelDir`) and is read on every
  // call rather than once: camoufox-js freezes its own copy at import time, and a caller that
  // redirects the engine directory after that import must still be honoured.
  const configured = process.env.CAMOUFOX_INSTALL_DIR
  if (configured) {
    return path.resolve(configured)
  }
  const { INSTALL_DIR } = await import(camoufoxModule('dist/pkgman.js'))
  return INSTALL_DIR.toString()
}

/**
 * True when the engine directory exists, is not empty, and holds no engine — i.e. the user pointed
 * VFox at the wrong folder.
 */
async function looksLikeSomethingElse(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir)
    return entries.length > 0 && !entries.includes(LAUNCH_FILE)
  } catch {
    return false
  }
}

/**
 * Refuse to start a ~1.5 GB install with no room for it.
 *
 * The archive is ~550 MB and extracts to roughly 1 GB, and the download is staged in `os.tmpdir()`
 * first, so the requirement is deliberately generous. A missing engine directory is walked up to
 * its nearest existing ancestor, because that is where the bytes will actually land.
 */
async function requireFreeSpace(target: string): Promise<void> {
  const free = await freeBytes(target)
  if (free === null || free >= REQUIRED_FREE_BYTES) {
    return
  }
  throw new Error(
    `Not enough free disk space to install the Camoufox engine: ${formatBytes(free)} available ` +
      `at ${path.resolve(target)}, about ${formatBytes(REQUIRED_FREE_BYTES)} required ` +
      '(the download is ~550 MB and extracts to ~1 GB). Free some space or set ' +
      'CAMOUFOX_INSTALL_DIR to a drive with more room.',
  )
}

async function freeBytes(target: string): Promise<number | null> {
  let dir = path.resolve(target)
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const stats = await fs.statfs(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = path.dirname(dir)
      if (code !== 'ENOENT' || parent === dir) {
        return null
      }
      dir = parent
    }
  }
  return null
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
