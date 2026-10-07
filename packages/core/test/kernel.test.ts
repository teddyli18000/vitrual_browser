import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KernelInfoSchema, type KernelProgress } from '@vfox/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyKernelDir, type EngineInstaller, KernelManager } from '../src/kernel.js'
import { kernelLauncherName } from '../src/kernels.js'

/**
 * The launcher's file name for the platform running the test.
 *
 * Hard-coding `camoufox.exe` made every fixture kernel invisible on the Linux CI runner: the build
 * was reported as having no launcher, so an "installed engine" came back as `installed: false`. That
 * is the same class of mistake as a test that reads the machine — the assertion was about the
 * developer's platform rather than about the code.
 */
const LAUNCHER = kernelLauncherName()

let installDir: string
let originalKernelDir: string | undefined

beforeAll(async () => {
  installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-kernel-'))
  originalKernelDir = process.env.CAMOUFOX_INSTALL_DIR
  // `KernelManager` reads this on every call, so pointing it at a temp directory is enough to
  // exercise the missing/unusable cases without touching the real engine.
  process.env.CAMOUFOX_INSTALL_DIR = installDir
})

afterAll(async () => {
  // Leave the environment exactly as it was found: the suite shares one worker, so a leaked value
  // would silently change what the other files see.
  if (originalKernelDir === undefined) {
    delete process.env.CAMOUFOX_INSTALL_DIR
  } else {
    process.env.CAMOUFOX_INSTALL_DIR = originalKernelDir
  }
  await fs.rm(installDir, { recursive: true, force: true })
})

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function manager(installer?: EngineInstaller) {
  const log = logger()
  return {
    log,
    kernel: new KernelManager({ logger: log, installer }),
  }
}

describe('applyKernelDir', () => {
  it('sets CAMOUFOX_INSTALL_DIR and leaves an unset option alone', () => {
    const before = process.env.CAMOUFOX_INSTALL_DIR
    applyKernelDir(undefined)
    expect(process.env.CAMOUFOX_INSTALL_DIR).toBe(before)

    applyKernelDir(path.join(os.tmpdir(), 'elsewhere'))
    expect(process.env.CAMOUFOX_INSTALL_DIR).toBe(path.join(os.tmpdir(), 'elsewhere'))
    process.env.CAMOUFOX_INSTALL_DIR = before
  })
})

describe('info', () => {
  it('reports a missing engine', async () => {
    const { kernel } = manager()
    const info = await kernel.info()

    expect(KernelInfoSchema.parse(info)).toEqual({
      installed: false,
      version: null,
      path: null,
      source: 'missing',
      kernels: [],
      defaultVersion: null,
      totalBytes: 0,
      // The installable list is a compile-time constant, so it is present even with nothing installed:
      // that is what lets the settings panel offer a version on a machine that has no engine yet.
      availableVersions: ['152.0.4-beta.30', '152.0.4-beta.29', '152.0.4-beta.28'],
    })
  })

  it('reports an installed engine with its version and path', async () => {
    // A legacy flat install: the launcher, the version marker, and the engine's property table, which
    // camoufox-js reads from the directory the executable lives in.
    await fs.writeFile(path.join(installDir, LAUNCHER), 'binary')
    await fs.writeFile(path.join(installDir, 'properties.json'), '[]')
    await fs.writeFile(
      path.join(installDir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
    )

    const { kernel } = manager()
    const info = await kernel.info()

    expect(info).toMatchObject({
      installed: true,
      version: '152.0.4-beta.31',
      path: installDir,
      source: 'cache',
      defaultVersion: '152.0.4-beta.31',
    })
    expect(info.kernels).toHaveLength(1)
    expect(info.kernels[0]).toMatchObject({
      version: '152.0.4-beta.31',
      location: 'legacy-root',
      problem: null,
    })
    expect(info.totalBytes).toBeGreaterThan(0)
  })

  it('warns instead of pretending when the directory holds no engine at all', async () => {
    await fs.writeFile(path.join(installDir, 'version.json'), 'not json')

    const { kernel, log } = manager()
    const info = await kernel.info()

    // A directory with no readable version.json is not an installed engine, and saying it is would be
    // the lie the old behaviour told; the warning names the directory the user configured.
    expect(info.installed).toBe(false)
    expect(info.version).toBeNull()
    expect(info.kernels).toEqual([])
    expect(log.warn).toHaveBeenCalledOnce()

    await fs.writeFile(
      path.join(installDir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
    )
  })
})

describe('install', () => {
  // Each install test gets its own kernel root: the `info` tests above leave a legacy build in the
  // shared directory, and a leftover kernel is exactly the state these assertions must not depend on.
  let installRoot: string

  beforeEach(async () => {
    installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-kernel-install-'))
    process.env.CAMOUFOX_INSTALL_DIR = installRoot
  })

  afterEach(async () => {
    process.env.CAMOUFOX_INSTALL_DIR = installDir
    await fs.rm(installRoot, { recursive: true, force: true })
  })

  it('emits checking -> the installer phases -> done with complete objects', async () => {
    const seen: KernelProgress[] = []
    const { kernel } = manager(async (emit, request) => {
      emit({
        phase: 'downloading',
        percent: 42,
        receivedBytes: 42,
        totalBytes: 100,
        message: `Downloading Camoufox ${request.version}`,
      })
      emit({ phase: 'extracting', message: `Extracting Camoufox ${request.version}` })
      // A real installer leaves a complete build behind; the manager's `done` message is only allowed
      // to claim success when one is actually there.
      await fs.mkdir(request.targetDir, { recursive: true })
      await fs.writeFile(path.join(request.targetDir, LAUNCHER), 'binary')
      await fs.writeFile(path.join(request.targetDir, 'properties.json'), '[]')
      await fs.writeFile(
        path.join(request.targetDir, 'version.json'),
        JSON.stringify({ version: '152.0.4', release: 'beta.30' }),
      )
    })
    kernel.on('progress', progress => seen.push(progress))

    const info = await kernel.install()

    expect(seen.map(item => item.phase)).toEqual(['checking', 'downloading', 'extracting', 'done'])
    expect(seen[0]).toEqual({
      phase: 'checking',
      percent: null,
      receivedBytes: null,
      totalBytes: null,
      message: 'Checking Camoufox 152.0.4-beta.30',
    })
    expect(seen[1]?.percent).toBe(42)
    expect(seen[2]).toEqual({
      phase: 'extracting',
      percent: null,
      receivedBytes: null,
      totalBytes: null,
      message: 'Extracting Camoufox 152.0.4-beta.30',
    })
    expect(seen[3]?.percent).toBe(100)
    for (const progress of seen) {
      expect(progress.phase).toBeTypeOf('string')
    }
    expect(info.installed).toBe(true)
    expect(info.kernels).toHaveLength(1)
    expect(info.kernels[0]).toMatchObject({
      version: '152.0.4-beta.30',
      location: 'kernels',
      problem: null,
    })
    // The kernel went to the versioned directory, not into the root.
    expect(info.path).toBe(path.join(installRoot, 'kernels', '152.0.4-beta.30'))
  })

  it('refuses a version this build was not tested against', async () => {
    const { kernel } = manager(async () => {})

    await expect(kernel.install('156.0.1-beta.34')).rejects.toThrow(
      'not one of the versions this build was tested against',
    )
  })

  it('is a no-op when the requested version is already installed', async () => {
    const dir = path.join(installRoot, 'kernels', '152.0.4-beta.30')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, LAUNCHER), 'binary')
    await fs.writeFile(path.join(dir, 'properties.json'), '[]')
    await fs.writeFile(
      path.join(dir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.30' }),
    )
    const installer = vi.fn<EngineInstaller>(async () => {})
    const { kernel } = manager(installer)

    const info = await kernel.install('152.0.4-beta.30')

    expect(installer).not.toHaveBeenCalled()
    expect(info.installed).toBe(true)
  })

  it('emits error and rethrows when the installer fails', async () => {
    const seen: KernelProgress[] = []
    const { kernel } = manager(async () => {
      throw new Error('Failed to fetch releases after 5 attempts')
    })
    kernel.on('progress', progress => seen.push(progress))

    await expect(kernel.install()).rejects.toThrow('Failed to fetch releases')

    expect(seen.map(item => item.phase)).toEqual(['checking', 'error'])
    expect(seen[1]?.message).toBe('Failed to fetch releases after 5 attempts')
  })

  it('runs one install at a time', async () => {
    let runs = 0
    const { kernel } = manager(async emit => {
      runs += 1
      emit({ phase: 'downloading', message: 'once' })
    })

    await Promise.all([kernel.install(), kernel.install(), kernel.install()])

    expect(runs).toBe(1)
  })

  it('allows a retry after a failure and stops delivering after unsubscribe', async () => {
    let attempts = 0
    const { kernel } = manager(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('boom')
      }
    })
    const listener = vi.fn()
    const off = kernel.on('progress', listener)

    await expect(kernel.install()).rejects.toThrow('boom')
    const calls = listener.mock.calls.length
    off()
    await kernel.install()

    expect(attempts).toBe(2)
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('survives a listener that throws', async () => {
    const { kernel, log } = manager(async () => {})
    kernel.on('progress', () => {
      throw new Error('sse client exploded')
    })

    await kernel.install()

    expect(log.warn).toHaveBeenCalled()
  })
})
