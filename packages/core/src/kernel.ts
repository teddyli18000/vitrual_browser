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
import type { KernelInfo, KernelPhase, KernelProgress } from '@vfox/shared'
import type { CamoufoxFetcher } from 'camoufox-js/dist/pkgman.js'
import type { CoreLogger } from './index.js'

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
    const dir = await installDir()
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
export const installCamoufoxEngine: EngineInstaller = async emit => {
  const pkgman = await import('camoufox-js/dist/pkgman.js')
  const { DefaultAddons, maybeDownloadAddons } = await import('camoufox-js/dist/addons.js')
  const { downloadMMDB } = await import('camoufox-js/dist/locale.js')

  const target = pkgman.INSTALL_DIR.toString()
  const fetcher = new pkgman.CamoufoxFetcher()
  await fetcher.init()

  let current: string | null = null
  try {
    current = pkgman.installedVerStr()
  } catch {
    current = null
  }

  if (current !== fetcher.verstr || !(await exists(path.join(target, LAUNCH_FILE)))) {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-camoufox-'))
    try {
      const archive = await downloadEngine(fetcher, staging, emit)
      emit({ phase: 'extracting', message: `Extracting Camoufox ${fetcher.verstr}` })
      pkgman.CamoufoxFetcher.cleanup()
      await fs.mkdir(target, { recursive: true })
      await fetcher.extractZip(archive)
      fetcher.setVersion()
      if (process.platform !== 'win32') {
        execFileSync('chmod', ['-R', '755', target])
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  if (!(await exists(path.join(target, MMDB_FILE)))) {
    emit({ phase: 'downloading', message: 'Downloading the GeoIP database' })
    await downloadMMDB()
  }
  await maybeDownloadAddons(DefaultAddons)
}

/** Stream the engine archive into `staging` and return its path, reporting real byte counts. */
async function downloadEngine(
  fetcher: CamoufoxFetcher,
  staging: string,
  emit: ProgressReporter,
): Promise<string> {
  const { webdl } = await import('camoufox-js/dist/pkgman.js')
  const archive = path.join(staging, 'camoufox.zip')
  const file = createWriteStream(archive)
  const total = await contentLength(fetcher.url)
  let received = 0

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      emit({
        phase: 'downloading',
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        receivedBytes: received,
        totalBytes: total,
        message: `Downloading Camoufox ${fetcher.verstr}`,
      })
      file.write(chunk, callback)
    },
  })

  emit({
    phase: 'downloading',
    percent: 0,
    receivedBytes: 0,
    totalBytes: total,
    message: `Downloading Camoufox ${fetcher.verstr}`,
  })

  try {
    // `webdl` keeps camoufox-js's retry policy and GitHub auth handling; the Writable is how its
    // output is observed (it writes every chunk into the buffer it is given).
    await webdl(fetcher.url, '', false, sink)
    await new Promise<void>((resolve, reject) => {
      file.close(error => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    if (!file.closed) {
      await new Promise<void>(resolve => file.close(() => resolve()))
    }
    throw error
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

async function installDir(): Promise<string> {
  const { INSTALL_DIR } = await import('camoufox-js/dist/pkgman.js')
  return INSTALL_DIR.toString()
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
