import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_BATCH_PROFILES, ProfileBatchCreateSchema } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Core, createCore } from '../src/index.js'
import { type BatchEntry, Store } from '../src/store.js'

let dataDir: string
let core: Core

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function entry(name: string): BatchEntry {
  return {
    input: { name },
    identity: { version: 1, engine: 'test', generatedAt: 'x', fingerprint: {} },
    config: {},
    webgl: undefined,
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-batch-'))
  core = await createCore({ dataDir })
})

afterEach(async () => {
  await core.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('createBatch', () => {
  it('creates N profiles named "<prefix> <index>", in creation order, each its own device', async () => {
    const profiles = await core.profiles.createBatch({ count: 5, namePrefix: '工作号' })

    expect(profiles.map(profile => profile.name)).toEqual([
      '工作号 1',
      '工作号 2',
      '工作号 3',
      '工作号 4',
      '工作号 5',
    ])
    expect(new Set(profiles.map(profile => profile.id)).size).toBe(5)
    for (const profile of profiles) {
      expect(profile.identity?.version).toBe(1)
      expect(profile.fingerprint.config['canvas:seed']).toBeTypeOf('number')
    }
    // Independently generated, not one identity copied N times.
    const devices = new Set(profiles.map(profile => JSON.stringify(profile.identity?.fingerprint)))
    expect(devices.size).toBe(5)

    // The result order is the store order.
    expect((await core.profiles.list()).map(profile => profile.id)).toEqual(
      profiles.map(profile => profile.id),
    )
  })

  it('applies the shared group, proxy, launch options and fingerprint overrides to all of them', async () => {
    const group = await core.groups.create('注册')
    const profiles = await core.profiles.createBatch({
      count: 2,
      namePrefix: 'acct',
      groupId: group.id,
      proxy: { type: 'socks5', host: '10.0.0.1', port: 1080 },
      launch: { headless: true },
      fingerprint: { os: 'macos', humanize: true },
    })

    for (const profile of profiles) {
      expect(profile.groupId).toBe(group.id)
      expect(profile.proxy).toEqual({ type: 'socks5', host: '10.0.0.1', port: 1080 })
      expect(profile.launch).toEqual({ headless: true, startUrl: null })
      expect(profile.fingerprint.os).toBe('macos')
      expect(profile.fingerprint.humanize).toBe(true)
    }
  })

  it('enforces the shared cap', async () => {
    expect(
      ProfileBatchCreateSchema.safeParse({
        count: MAX_BATCH_PROFILES + 1,
        namePrefix: 'x',
      }).success,
    ).toBe(false)
    await expect(
      core.profiles.createBatch({ count: MAX_BATCH_PROFILES + 1, namePrefix: 'x' }),
    ).rejects.toThrow()
    expect(await core.profiles.list()).toEqual([])
  })
})

/**
 * All-or-nothing, proved by injecting a failure rather than by asserting the intention.
 *
 * The first case fails at the **seventh of twenty** entries: the store must be byte-for-byte what it
 * was, with no profile and no directory to clean up afterwards. The second fails in the filesystem
 * *after* validation, which is the other half of the same guarantee.
 */
describe('all or nothing', () => {
  /** A store on its own directory, so these cases cannot interfere with the open `core`. */
  async function freshStore(): Promise<{ store: Store; dir: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-batch-store-'))
    const store = new Store(dir, logger())
    await store.load()
    return { store, dir }
  }

  it('writes nothing when the seventh of twenty entries is invalid', async () => {
    const { store, dir } = await freshStore()
    try {
      const entries = Array.from({ length: 20 }, (_value, index) =>
        entry(index === 6 ? '' : `acct ${index + 1}`),
      )

      await expect(store.createProfiles(entries)).rejects.toThrow()

      expect(store.listProfiles()).toEqual([])
      // No profile directory was left behind, and the table was never written.
      await expect(fs.access(path.join(dir, 'profiles'))).rejects.toThrow()
      await expect(fs.access(path.join(dir, 'profiles.json'))).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves the store untouched when the batch cannot be written at all', async () => {
    const blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-batch-blocked-'))
    try {
      // A *file* where the profiles directory belongs: every mkdir in the batch fails.
      await fs.writeFile(path.join(blocked, 'profiles'), 'not a directory', 'utf8')
      const blockedCore = await createCore({ dataDir: blocked })
      try {
        await expect(
          blockedCore.profiles.createBatch({ count: 3, namePrefix: 'nope' }),
        ).rejects.toThrow()
        expect(await blockedCore.profiles.list()).toEqual([])
        expect(await fs.readFile(path.join(blocked, 'profiles'), 'utf8')).toBe('not a directory')
      } finally {
        await blockedCore.close()
      }
    } finally {
      await fs.rm(blocked, { recursive: true, force: true })
    }
  })

  it('does not disturb profiles that already exist', async () => {
    const { store, dir } = await freshStore()
    try {
      const existing = await store.createProfile({ name: 'keep me' })

      await expect(
        store.createProfiles([entry('ok 1'), entry('ok 2'), entry('')]),
      ).rejects.toThrow()

      expect(store.listProfiles().map(profile => profile.name)).toEqual(['keep me'])
      // And on disk, which is what a restart would read.
      const reopened = new Store(dir, logger())
      await reopened.load()
      expect(reopened.listProfiles().map(profile => profile.name)).toEqual(['keep me'])
      expect(reopened.getProfile(existing.id)?.name).toBe('keep me')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
