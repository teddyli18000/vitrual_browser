import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/store.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-integrity-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function openStore(
  log = logger(),
): Promise<{ store: Store; log: ReturnType<typeof logger> }> {
  const store = new Store(dataDir, log)
  await store.load()
  return { store, log }
}

describe('previous generation backup', () => {
  it('keeps the previous profiles.json as .bak before replacing it', async () => {
    const { store } = await openStore()
    await store.createProfile({ name: 'First' })
    // The very first write has nothing to back up.
    await expect(fs.access(`${store.profilesFile}.bak`)).rejects.toThrow()

    await store.createProfile({ name: 'Second' })

    const backup = JSON.parse(await fs.readFile(`${store.profilesFile}.bak`, 'utf8')) as {
      name: string
    }[]
    expect(backup.map(profile => profile.name)).toEqual(['First'])
    expect(JSON.parse(await fs.readFile(store.profilesFile, 'utf8'))).toHaveLength(2)
  })
})

describe('recovery from a corrupt store', () => {
  it('quarantines the corrupt file, restores the backup and reports it loudly', async () => {
    const { store } = await openStore()
    await store.createProfile({ name: 'Acme' })
    await store.createProfile({ name: 'Second' })
    expect(await fs.readFile(`${store.profilesFile}.bak`, 'utf8')).toContain('Acme')

    // Simulate a torn write.
    await fs.writeFile(store.profilesFile, '[{"id":"Acme","na', 'utf8')

    const log = logger()
    const reopened = new Store(dataDir, log)
    await reopened.load()

    expect((await reopened.listProfiles()).map(profile => profile.name)).toEqual(['Acme'])
    expect(log.error).toHaveBeenCalledOnce()
    expect(String(log.error.mock.calls[0]?.[0])).toContain('restored from')

    const quarantined = (await fs.readdir(dataDir)).filter(name =>
      name.startsWith('profiles.corrupt-'),
    )
    expect(quarantined).toHaveLength(1)
    expect(await fs.readFile(path.join(dataDir, quarantined[0] as string), 'utf8')).toBe(
      '[{"id":"Acme","na',
    )
    // The restored store is usable and immediately re-backed up on the next write.
    await reopened.createProfile({ name: 'Third' })
    expect(JSON.parse(await fs.readFile(reopened.profilesFile, 'utf8'))).toHaveLength(2)
  })

  it('fails loudly and leaves the file in place when there is no usable backup', async () => {
    await fs.writeFile(path.join(dataDir, 'profiles.json'), 'not json at all', 'utf8')

    await expect(openStore()).rejects.toThrow(/no backup is available/)
    // Left exactly where it was, so the next start fails loudly too instead of starting empty.
    expect(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).toBe('not json at all')
    expect((await fs.readdir(dataDir)).filter(name => name.includes('corrupt'))).toEqual([])
  })

  it('fails loudly when the backup is corrupt too', async () => {
    await fs.writeFile(path.join(dataDir, 'profiles.json'), '{"not":"an array"}', 'utf8')
    await fs.writeFile(path.join(dataDir, 'profiles.json.bak'), 'also broken', 'utf8')

    await expect(openStore()).rejects.toThrow(/the backup at .* is invalid too/)
  })

  it('recovers groups.json the same way', async () => {
    const { store } = await openStore()
    await store.createGroup('Work')
    await store.createGroup('Clients')
    await fs.writeFile(store.groupsFile, 'garbage', 'utf8')

    const reopened = new Store(dataDir, logger())
    await reopened.load()

    expect((await reopened.listGroups()).map(group => group.name)).toEqual(['Work'])
  })
})

describe('applyIdentity', () => {
  it('stores the identity, pins config keys and clears it again', async () => {
    const { store } = await openStore()
    const created = await store.createProfile({ name: 'Acme' })
    expect(created.identity).toBeNull()

    const identity = {
      version: 1 as const,
      engine: '152.0.4',
      generatedAt: '2024-01-01T00:00:00.000Z',
      fingerprint: { navigator: { userAgent: 'Firefox/152.0' } },
    }
    const withIdentity = await store.applyIdentity(created.id, identity, {
      config: { 'canvas:seed': 42 },
      webgl: { vendor: 'Google Inc.', renderer: 'ANGLE' },
    })

    expect(withIdentity.identity).toEqual(identity)
    expect(withIdentity.fingerprint.config).toEqual({ 'canvas:seed': 42 })
    expect(withIdentity.fingerprint.webgl).toEqual({ vendor: 'Google Inc.', renderer: 'ANGLE' })
    expect((await store.getProfile(created.id))?.identity).toEqual(identity)

    const cleared = await store.applyIdentity(created.id, null)
    expect(cleared.identity).toBeNull()
    // Pinned values survive clearing the identity: they are not re-rolled with the device.
    expect(cleared.fingerprint.config).toEqual({ 'canvas:seed': 42 })
    expect(cleared.fingerprint.webgl).toEqual({ vendor: 'Google Inc.', renderer: 'ANGLE' })
  })

  it('merges the pinned config keys over what is already stored', async () => {
    const { store } = await openStore()
    const created = await store.createProfile({
      name: 'Acme',
      fingerprint: { config: { 'canvas:seed': 1 } },
    })

    const updated = await store.applyIdentity(
      created.id,
      { version: 1, engine: null, generatedAt: 'x', fingerprint: {} },
      { config: { 'canvas:seed': 99, 'audio:seed': 5 } },
    )

    expect(updated.fingerprint.config).toEqual({ 'canvas:seed': 99, 'audio:seed': 5 })
  })
})
