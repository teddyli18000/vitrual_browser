import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KernelInfoSchema } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Core, createCore } from '../src/index.js'

let dataDir: string
let workDir: string
let core: Core

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-core-'))
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-core-work-'))
  core = await createCore({ dataDir })
})

afterEach(async () => {
  await core.close()
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('createCore', () => {
  it('exposes the data directory and creates it', async () => {
    expect(core.dataDir).toBe(path.resolve(dataDir))
    expect((await fs.stat(core.dataDir)).isDirectory()).toBe(true)
  })

  it('persists profiles across instances', async () => {
    const created = await core.profiles.create({ name: 'Acme' })
    await core.close()

    core = await createCore({ dataDir })
    expect(await core.profiles.get(created.id)).toEqual(created)
    expect(await core.profiles.list()).toHaveLength(1)
  })

  it('reports unknown profiles as undefined', async () => {
    expect(await core.profiles.get('missing')).toBeUndefined()
  })

  it('updates and removes a profile', async () => {
    const created = await core.profiles.create({ name: 'Acme' })
    const updated = await core.profiles.update(created.id, { name: 'Acme 2', notes: 'hello' })
    expect(updated.name).toBe('Acme 2')

    await core.profiles.remove(created.id)
    expect(await core.profiles.list()).toEqual([])
    await expect(fs.access(core.profiles.userDataDir(created.id))).rejects.toThrow()
  })

  it('clones a profile through the API', async () => {
    const created = await core.profiles.create({ name: 'Acme' })
    const copy = await core.profiles.clone(created.id, 'Twin')

    expect(copy.id).not.toBe(created.id)
    expect(copy.name).toBe('Twin')
    expect(await core.profiles.list()).toHaveLength(2)
  })

  it('manages groups', async () => {
    const group = await core.groups.create('Work')
    expect((await core.groups.list()).map(item => item.name)).toEqual(['Work'])

    const renamed = await core.groups.rename(group.id, 'Clients')
    expect(renamed.name).toBe('Clients')

    await core.groups.remove(group.id)
    expect(await core.groups.list()).toEqual([])
  })
})

describe('runtime', () => {
  it('reports every profile as stopped without ever launching a browser', async () => {
    const created = await core.profiles.create({ name: 'Acme' })

    expect(await core.runtime.list()).toEqual([
      {
        profileId: created.id,
        status: 'stopped',
        pid: null,
        wsEndpoint: null,
        startedAt: null,
        lastError: null,
      },
    ])
    expect(core.runtime.get(created.id).status).toBe('stopped')
    expect(core.runtime.get('missing').status).toBe('stopped')
  })

  it('stops a profile that is not running without touching the engine', async () => {
    const created = await core.profiles.create({ name: 'Acme' })
    expect((await core.runtime.stop(created.id)).status).toBe('stopped')
  })

  it('delivers runtime changes to subscribers and unsubscribes', async () => {
    const created = await core.profiles.create({ name: 'Acme' })
    const listener = vi.fn()
    const off = core.runtime.on('change', listener)

    await core.runtime.stop(created.id)
    expect(listener).toHaveBeenCalled()

    off()
    const calls = listener.mock.calls.length
    await core.runtime.stop(created.id)
    expect(listener).toHaveBeenCalledTimes(calls)
  })
})

describe('kernel', () => {
  it('reports a valid kernel info object', async () => {
    expect(KernelInfoSchema.parse(await core.kernel.info())).toBeTruthy()
  })

  it('subscribes to install progress', () => {
    const off = core.kernel.on('progress', () => {})
    expect(off).toBeTypeOf('function')
    off()
  })
})

describe('export and import through the API', () => {
  it('round-trips a profile', async () => {
    const created = await core.profiles.create({
      name: 'Acme',
      fingerprint: { os: 'macos' },
      proxy: { type: 'socks5', host: '10.0.0.1', port: 1080 },
    })
    await fs.mkdir(core.profiles.userDataDir(created.id), { recursive: true })
    await fs.writeFile(path.join(core.profiles.userDataDir(created.id), 'prefs.js'), 'x')

    const zipFile = path.join(workDir, 'acme.vfox.zip')
    await core.profiles.exportZip(created.id, zipFile)
    const imported = await core.profiles.importZip(zipFile)

    expect(imported.id).not.toBe(created.id)
    expect(imported.name).toBe('Acme (imported)')
    expect(imported.fingerprint).toEqual(created.fingerprint)
    expect(imported.proxy).toEqual(created.proxy)
    expect(
      await fs.readFile(path.join(core.profiles.userDataDir(imported.id), 'prefs.js'), 'utf8'),
    ).toBe('x')
  })

  it('fails loudly for an unknown profile and an unknown archive', async () => {
    await expect(core.profiles.exportZip('missing', path.join(workDir, 'x.zip'))).rejects.toThrow(
      'Unknown profile',
    )
    await expect(core.profiles.importZip(path.join(workDir, 'missing.zip'))).rejects.toThrow(
      /archive not found/,
    )
  })
})

describe('corrupt store', () => {
  it('refuses to start instead of silently resetting the user data', async () => {
    await fs.writeFile(path.join(dataDir, 'profiles.json'), '[{"id":"broken"}]', 'utf8')

    await expect(createCore({ dataDir })).rejects.toThrow(/profile at index 0 is invalid/)
    expect(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).toBe('[{"id":"broken"}]')
  })
})
