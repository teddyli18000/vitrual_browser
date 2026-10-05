/**
 * Issue #22: the store is shared state, so a running process has to see what another process wrote.
 *
 * The reproduction was:
 *
 *   vfox create Alpha          # a second process writes profiles.json
 *   GET /profiles              # on the ALREADY RUNNING server -> count = 0
 *   vfox sync start Alpha      # -> Unknown profile
 *
 * Every test here is written as two independent `Store` instances over one directory, which is what
 * "another process" looks like from inside a single test process. The second half covers the trap
 * that made the naive fix wrong: making only the *reads* live would leave the whole-table write
 * clobbering, so a create through one instance would erase what the other had just created.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreLogger } from '../src/index.js'
import { createCore } from '../src/index.js'
import { Store } from '../src/store.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-live-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A logger that records only what the recovery path writes. */
function recorder(): { logger: CoreLogger; errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
    },
  }
}

/** Two stores over one directory: the test's stand-in for two processes. */
async function twoStores(): Promise<{ first: Store; second: Store }> {
  const first = new Store(dir)
  await first.load()
  const second = new Store(dir)
  await second.load()
  return { first, second }
}

describe('a store sees what another instance wrote', () => {
  it('lists a profile created elsewhere, with no reload', async () => {
    const { first, second } = await twoStores()

    expect(await first.listProfiles()).toEqual([])
    const created = await second.createProfile({ name: 'Alpha' })

    const listed = await first.listProfiles()
    expect(listed.map(profile => profile.name)).toEqual(['Alpha'])
    expect(listed[0]?.id).toBe(created.id)
  })

  it('finds it by id, and reports it as a known id', async () => {
    const { first, second } = await twoStores()
    const created = await second.createProfile({ name: 'Alpha' })

    expect((await first.getProfile(created.id))?.name).toBe('Alpha')
    expect((await first.requireProfile(created.id)).name).toBe('Alpha')
    expect(await first.profileIds()).toEqual([created.id])
  })

  it('stops reporting a profile removed elsewhere', async () => {
    const { first, second } = await twoStores()
    const created = await second.createProfile({ name: 'Alpha' })

    await second.removeProfile(created.id)

    expect(await first.listProfiles()).toEqual([])
    expect(await first.getProfile(created.id)).toBeUndefined()
    await expect(first.requireProfile(created.id)).rejects.toThrow(/Unknown profile/)
  })

  it('sees a profile updated elsewhere', async () => {
    const { first, second } = await twoStores()
    const created = await second.createProfile({ name: 'Alpha' })

    await second.updateProfile(created.id, { name: 'Renamed', notes: 'edited elsewhere' })

    const seen = await first.requireProfile(created.id)
    expect(seen.name).toBe('Renamed')
    expect(seen.notes).toBe('edited elsewhere')
  })

  it('sees a group created elsewhere, and one removed elsewhere', async () => {
    const { first, second } = await twoStores()

    const group = await second.createGroup('Work')
    expect((await first.listGroups()).map(entry => entry.name)).toEqual(['Work'])

    await second.renameGroup(group.id, 'Work 2')
    expect((await first.listGroups()).map(entry => entry.name)).toEqual(['Work 2'])

    await second.removeGroup(group.id)
    expect(await first.listGroups()).toEqual([])
  })

  it('is symmetric: the first instance can write and the second sees it', async () => {
    const { first, second } = await twoStores()

    await first.createProfile({ name: 'FromFirst' })

    expect((await second.listProfiles()).map(profile => profile.name)).toEqual(['FromFirst'])
  })
})

describe('a mutation re-reads before it writes', () => {
  it('does not erase a profile another instance created', async () => {
    const { first, second } = await twoStores()

    // The order matters: `second` writes first, so `first` would have to write a stale table to
    // lose it. This is the case that a reads-only fix would leave broken.
    await second.createProfile({ name: 'Alpha' })
    await first.createProfile({ name: 'Beta' })

    const names = (await first.listProfiles()).map(profile => profile.name).sort()
    expect(names).toEqual(['Alpha', 'Beta'])

    // And on disk, which is what a restart would read.
    const reopened = new Store(dir)
    await reopened.load()
    expect((await reopened.listProfiles()).map(profile => profile.name).sort()).toEqual([
      'Alpha',
      'Beta',
    ])
  })

  it('does not erase one on update, remove or group change', async () => {
    const { first, second } = await twoStores()
    const alpha = await second.createProfile({ name: 'Alpha' })
    const beta = await second.createProfile({ name: 'Beta' })

    await first.updateProfile(alpha.id, { notes: 'touched by the other instance' })
    await first.createGroup('Work')
    await first.removeProfile(beta.id)

    const reopened = new Store(dir)
    await reopened.load()
    const profiles = await reopened.listProfiles()
    expect(profiles.map(profile => profile.name)).toEqual(['Alpha'])
    expect(profiles[0]?.notes).toBe('touched by the other instance')
    expect((await reopened.listGroups()).map(group => group.name)).toEqual(['Work'])
  })

  it('keeps concurrent creates from one instance', async () => {
    const store = new Store(dir)
    await store.load()

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => store.createProfile({ name: `P${index}` })),
    )

    expect(await store.listProfiles()).toHaveLength(12)
  })
})

describe('a core sees profiles created while it is running', () => {
  it('reports them through the profile API and the runtime registry', async () => {
    const core = await createCore({ dataDir: dir })
    try {
      expect(await core.profiles.list()).toEqual([])

      // The `vfox create` in another process.
      const other = new Store(dir)
      await other.load()
      const created = await other.createProfile({ name: 'Alpha' })

      expect((await core.profiles.list()).map(profile => profile.name)).toEqual(['Alpha'])
      expect((await core.profiles.get(created.id))?.name).toBe('Alpha')

      // `runtime.list()` derives membership from the store, so it has to see it too — otherwise
      // `GET /runtime` and the health count keep lying.
      const runtimes = await core.runtime.list()
      expect(runtimes.map(runtime => runtime.profileId)).toEqual([created.id])
      expect(runtimes[0]?.status).toBe('stopped')

      // And the group index, which had the same defect.
      await other.createGroup('Work')
      expect((await core.groups.list()).map(group => group.name)).toEqual(['Work'])
    } finally {
      await core.close()
    }
  })
})

describe('recovery triggered by a read', () => {
  it('repairs a corrupt table on the next read, not only at startup', async () => {
    const { logger, errors } = recorder()
    const store = new Store(dir, logger)
    await store.load()

    // Two writes, so a valid `.bak` exists (it holds the generation before the last one).
    await store.createProfile({ name: 'Acme' })
    await store.createProfile({ name: 'Beta' })

    await fs.writeFile(store.profilesFile, '{ this is not json', 'utf8')

    const recovered = await store.listProfiles()
    expect(recovered.map(profile => profile.name)).toEqual(['Acme'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/restored from/)

    // The repair is durable: a fresh instance sees the recovered table.
    const reopened = new Store(dir)
    await reopened.load()
    expect((await reopened.listProfiles()).map(profile => profile.name)).toEqual(['Acme'])
  })

  it('does the same for groups.json', async () => {
    const { logger, errors } = recorder()
    const store = new Store(dir, logger)
    await store.load()

    await store.createGroup('Work')
    await store.createGroup('Personal')
    await fs.writeFile(store.groupsFile, 'nonsense', 'utf8')

    expect((await store.listGroups()).map(group => group.name)).toEqual(['Work'])
    expect(errors).toHaveLength(1)
  })
})
