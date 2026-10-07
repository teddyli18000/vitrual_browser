import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistFailure, Store } from '../src/store.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-store-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function openStore(): Promise<Store> {
  const store = new Store(dataDir)
  await store.load()
  return store
}

describe('profiles', () => {
  it('creates with every shared-schema default filled in', async () => {
    const store = await openStore()
    const profile = await store.createProfile({ name: 'Acme' })

    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(profile.name).toBe('Acme')
    expect(profile.groupId).toBeNull()
    expect(profile.notes).toBe('')
    expect(profile.proxy).toBeNull()
    expect(profile.fingerprint).toEqual({
      os: 'windows',
      screen: null,
      window: null,
      webgl: null,
      fonts: null,
      locale: null,
      geoip: true,
      // `humanize` defaults to true in `FingerprintSchema`: VFox exists so a profile does not look
      // automated, so a profile created without touching the field gets human-like input.
      humanize: true,
      blockImages: false,
      blockWebrtc: false,
      blockWebgl: false,
      disableCoop: false,
      hardwareConcurrency: null,
      deviceMemory: null,
      userAgent: null,
      config: {},
    })
    expect(profile.launch).toEqual({ headless: false, startUrl: null })
    expect(profile.createdAt).toBe(profile.updatedAt)
  })

  it('round-trips through disk', async () => {
    const store = await openStore()
    const created = await store.createProfile({
      name: 'Acme',
      proxy: { type: 'http', host: 'h', port: 8080 },
      fingerprint: { os: 'linux', humanize: true },
    })

    const reopened = await openStore()
    expect(await reopened.getProfile(created.id)).toEqual(created)
  })

  it('updates with partial fingerprint/launch merges and never loses the other fields', async () => {
    const store = await openStore()
    const created = await store.createProfile({
      name: 'Acme',
      fingerprint: { os: 'macos', humanize: true },
      launch: { headless: true },
    })

    const updated = await store.updateProfile(created.id, {
      name: 'Acme 2',
      fingerprint: { hardwareConcurrency: 4 },
      launch: { startUrl: 'https://example.com' },
    })

    expect(updated.name).toBe('Acme 2')
    expect(updated.fingerprint.os).toBe('macos')
    expect(updated.fingerprint.humanize).toBe(true)
    expect(updated.fingerprint.hardwareConcurrency).toBe(4)
    expect(updated.launch).toEqual({ headless: true, startUrl: 'https://example.com' })
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt >= created.updatedAt).toBe(true)
  })

  it('clears a proxy when the patch says null', async () => {
    const store = await openStore()
    const created = await store.createProfile({
      name: 'Acme',
      proxy: { type: 'http', host: 'h', port: 1 },
    })
    const updated = await store.updateProfile(created.id, { proxy: null })
    expect(updated.proxy).toBeNull()
  })

  it('rejects an unknown id and an invalid patch', async () => {
    const store = await openStore()
    await expect(store.updateProfile('nope', { name: 'x' })).rejects.toThrow('Unknown profile')
    await expect(store.createProfile({ name: '' })).rejects.toThrow()
  })
})

describe('clone and remove', () => {
  it('clones the config and the userdata directory under a new id', async () => {
    const store = await openStore()
    const source = await store.createProfile({ name: 'Acme', fingerprint: { os: 'macos' } })
    await fs.mkdir(store.userDataDir(source.id), { recursive: true })
    await fs.writeFile(path.join(store.userDataDir(source.id), 'cookies.sqlite'), 'data')

    const copy = await store.cloneProfile(source.id)

    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('Acme copy')
    expect(copy.fingerprint).toEqual(source.fingerprint)
    expect(await fs.readFile(path.join(store.userDataDir(copy.id), 'cookies.sqlite'), 'utf8')).toBe(
      'data',
    )

    const renamed = await store.cloneProfile(source.id, 'Custom')
    expect(renamed.name).toBe('Custom')
  })

  it('removes the entry and the directory', async () => {
    const store = await openStore()
    const profile = await store.createProfile({ name: 'Acme' })
    await fs.mkdir(store.userDataDir(profile.id), { recursive: true })

    await store.removeProfile(profile.id)

    expect(await store.getProfile(profile.id)).toBeUndefined()
    await expect(fs.access(store.profileDir(profile.id))).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(store.profilesFile, 'utf8'))).toEqual([])
  })

  it('refuses to remove an unknown profile', async () => {
    const store = await openStore()
    await expect(store.removeProfile('nope')).rejects.toThrow('Unknown profile')
  })
})

describe('persistence', () => {
  it('writes atomically and leaves no temp file behind', async () => {
    const store = await openStore()
    await store.createProfile({ name: 'Acme' })

    expect(JSON.parse(await fs.readFile(store.profilesFile, 'utf8'))).toHaveLength(1)
    await expect(fs.access(`${store.profilesFile}.tmp`)).rejects.toThrow()
  })

  it('serialises concurrent writes instead of losing entries', async () => {
    const store = await openStore()
    await Promise.all(
      Array.from({ length: 12 }, (_value, index) => store.createProfile({ name: `p${index}` })),
    )

    const onDisk = JSON.parse(await fs.readFile(store.profilesFile, 'utf8')) as unknown[]
    expect(onDisk).toHaveLength(12)
    expect(await store.listProfiles()).toHaveLength(12)
  })

  it('fails loudly on a corrupt file and never rewrites it', async () => {
    const store = await openStore()
    await store.createProfile({ name: 'Acme' })
    const good = await fs.readFile(store.profilesFile, 'utf8')

    await fs.writeFile(store.profilesFile, '{"not":"an array"}', 'utf8')
    await expect(openStore()).rejects.toThrow(/expected a JSON array of profile objects/)

    await fs.writeFile(store.profilesFile, '[{"id":"x"}]', 'utf8')
    await expect(openStore()).rejects.toThrow(/profile at index 0 is invalid/)

    await fs.writeFile(store.profilesFile, 'not json at all', 'utf8')
    await expect(openStore()).rejects.toThrow(/not valid JSON/)

    // Nothing was silently reset: the corrupt bytes are still exactly what was written.
    expect(await fs.readFile(store.profilesFile, 'utf8')).toBe('not json at all')
    expect(good).toContain('Acme')
  })

  it('starts empty when the files do not exist yet', async () => {
    const store = await openStore()
    expect(await store.listProfiles()).toEqual([])
    expect(await store.listGroups()).toEqual([])
  })
})

describe('groups', () => {
  it('creates, renames and removes', async () => {
    const store = await openStore()
    const group = await store.createGroup(' Work ')
    expect(group.name).toBe('Work')

    const renamed = await store.renameGroup(group.id, 'Clients')
    expect(renamed.name).toBe('Clients')
    expect(renamed.createdAt).toBe(group.createdAt)

    await store.removeGroup(group.id)
    expect(await store.listGroups()).toEqual([])
  })

  it('un-groups its profiles when the group is removed', async () => {
    const store = await openStore()
    const group = await store.createGroup('Work')
    const profile = await store.createProfile({ name: 'Acme', groupId: group.id })
    expect(profile.groupId).toBe(group.id)

    await store.removeGroup(group.id)

    expect((await store.getProfile(profile.id))?.groupId).toBeNull()
    expect(JSON.parse(await fs.readFile(store.groupsFile, 'utf8'))).toEqual([])
  })

  it('rejects empty names and unknown ids', async () => {
    const store = await openStore()
    await expect(store.createGroup('   ')).rejects.toThrow('must not be empty')
    await expect(store.renameGroup('nope', 'x')).rejects.toThrow('Unknown group')
    await expect(store.removeGroup('nope')).rejects.toThrow('Unknown group')
  })
})

describe('a write that could not be persisted (issue #74)', () => {
  // The assertion is the message, not the write: this is what reaches a user as a 500 from /launch when
  // Windows holds the destination open past every retry. It used to be the raw error -
  // `EPERM: operation not permitted, rename '…'` - which names neither the file nor the state the user is
  // left in. What this test can go red on: revert persistFailure to `String(error)` and the first three
  // expectations fail, because the path, the code and the attempt count are all absent from it.
  it('names the file, the reason, how long we tried, and that nothing was half-written', () => {
    const error = Object.assign(
      new Error("EPERM: operation not permitted, rename 'C:\\vfox\\data\\profiles.json.tmp' -> '…'"),
      { code: 'EPERM' },
    )
    const message = persistFailure('C:\\vfox\\data\\profiles.json', error)

    expect(message).toContain('C:\\vfox\\data\\profiles.json')
    expect(message).toContain('EPERM')
    expect(message).toContain('10 attempts')
    // The sentence that makes it actionable: a rename is atomic, so the old file is intact.
    expect(message).toContain('previous contents')
  })

  it('survives an error with no code, and still names the file', () => {
    const message = persistFailure('/data/profiles.json', new Error('something else entirely'))
    expect(message).toContain('/data/profiles.json')
    expect(message).toContain('no code')
    expect(message).toContain('something else entirely')
  })
})
