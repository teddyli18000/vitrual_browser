import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KernelInfoSchema, type KernelProgress } from '@vfox/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyKernelDir, type EngineInstaller, KernelManager } from '../src/kernel.js'

let installDir: string

beforeAll(async () => {
  installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-kernel-'))
  // camoufox-js resolves its install directory at module load, so this must be set before the
  // first `info()` call, which is what imports it.
  process.env.CAMOUFOX_INSTALL_DIR = installDir
})

afterAll(async () => {
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
    })
  })

  it('reports an installed engine with its version and path', async () => {
    await fs.writeFile(path.join(installDir, 'camoufox.exe'), 'binary')
    await fs.writeFile(
      path.join(installDir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
    )

    const { kernel } = manager()
    expect(await kernel.info()).toEqual({
      installed: true,
      version: '152.0.4-beta.31',
      path: installDir,
      source: 'cache',
    })
  })

  it('warns instead of pretending when version.json is unusable', async () => {
    await fs.writeFile(path.join(installDir, 'version.json'), 'not json')

    const { kernel, log } = manager()
    const info = await kernel.info()

    expect(info.installed).toBe(true)
    expect(info.version).toBeNull()
    expect(log.warn).toHaveBeenCalledOnce()

    await fs.writeFile(
      path.join(installDir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
    )
  })
})

describe('install', () => {
  it('emits checking -> the installer phases -> done with complete objects', async () => {
    const seen: KernelProgress[] = []
    const { kernel } = manager(async emit => {
      emit({
        phase: 'downloading',
        percent: 42,
        receivedBytes: 42,
        totalBytes: 100,
        message: 'Downloading Camoufox 152.0.4-beta.31',
      })
      emit({ phase: 'extracting', message: 'Extracting Camoufox 152.0.4-beta.31' })
    })
    kernel.on('progress', progress => seen.push(progress))

    const info = await kernel.install()

    expect(seen.map(item => item.phase)).toEqual(['checking', 'downloading', 'extracting', 'done'])
    expect(seen[0]).toEqual({
      phase: 'checking',
      percent: null,
      receivedBytes: null,
      totalBytes: null,
      message: 'Checking the latest Camoufox release',
    })
    expect(seen[1]?.percent).toBe(42)
    expect(seen[2]).toEqual({
      phase: 'extracting',
      percent: null,
      receivedBytes: null,
      totalBytes: null,
      message: 'Extracting Camoufox 152.0.4-beta.31',
    })
    expect(seen[3]?.percent).toBe(100)
    for (const progress of seen) {
      expect(progress.phase).toBeTypeOf('string')
    }
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
