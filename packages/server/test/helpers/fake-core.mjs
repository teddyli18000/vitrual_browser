/**
 * A fake `Core` for the server tests.
 *
 * The tests never touch a real browser: the development sandbox forbids the piped stdio Playwright
 * needs, and a unit test has no business downloading a 493 MB engine. This object implements the
 * frozen `Core` interface in memory, and it validates its own output through the shared zod schemas
 * so a drift in `@vfox/shared` breaks the fake as loudly as it would break the real core.
 *
 * Plain ESM on purpose — see `sandbox-preload.mjs`.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ProfileSchema } from '@vfox/shared'

export function createFakeCore(options) {
  const dataDir = options.dataDir
  const profilesById = new Map()
  const runtimeById = new Map()
  const groupsById = new Map()
  const runtimeSubscribers = new Set()
  const kernelSubscribers = new Set()

  const kernelInfo = {
    installed: true,
    version: '146.0.1',
    path: path.join(dataDir, 'kernel'),
    source: 'cache',
    ...options.kernel,
  }

  const now = () => new Date().toISOString()

  const stoppedRuntime = profileId => ({
    profileId,
    status: 'stopped',
    pid: null,
    wsEndpoint: null,
    startedAt: null,
    lastError: null,
  })

  const emit = runtime => {
    for (const subscriber of runtimeSubscribers) subscriber(runtime)
  }

  const requireProfile = id => {
    const profile = profilesById.get(id)
    if (!profile) throw new Error(`fake core: unknown profile ${id}`)
    return profile
  }

  const core = {
    dataDir,
    profilesById,
    runtimeById,
    groupsById,
    kernelInfo,
    closed: false,
    installCalls: 0,
    installError: undefined,
    installDelayMs: 0,
    installProgress: [],

    profiles: {
      list: async () => [...profilesById.values()],

      get: async id => profilesById.get(id),

      create: async input => {
        const id = randomUUID()
        const profile = ProfileSchema.parse({
          id,
          name: input.name,
          groupId: input.groupId ?? null,
          notes: input.notes ?? '',
          color: input.color ?? null,
          proxy: input.proxy ?? null,
          fingerprint: input.fingerprint ?? {},
          launch: input.launch ?? {},
          createdAt: now(),
          updatedAt: now(),
        })
        profilesById.set(id, profile)
        runtimeById.set(id, stoppedRuntime(id))
        return profile
      },

      update: async (id, patch) => {
        const current = requireProfile(id)
        const next = ProfileSchema.parse({
          ...current,
          ...patch,
          fingerprint: { ...current.fingerprint, ...(patch.fingerprint ?? {}) },
          launch: { ...current.launch, ...(patch.launch ?? {}) },
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: now(),
        })
        profilesById.set(id, next)
        return next
      },

      remove: async id => {
        requireProfile(id)
        profilesById.delete(id)
        runtimeById.delete(id)
      },

      clone: async (id, name) => {
        const source = requireProfile(id)
        return core.profiles.create({
          name: name ?? `${source.name} copy`,
          groupId: source.groupId,
          notes: source.notes,
          proxy: source.proxy,
          fingerprint: source.fingerprint,
          launch: source.launch,
        })
      },

      userDataDir: id => path.join(dataDir, 'profiles', id, 'userdata'),

      exportZip: async (id, destFile) => {
        const profile = requireProfile(id)
        await mkdir(path.dirname(destFile), { recursive: true })
        await writeFile(destFile, JSON.stringify({ fake: 'zip', profile }), 'utf8')
      },

      importZip: async (zipFile, name) => {
        const raw = await readFile(zipFile, 'utf8')
        const parsed = JSON.parse(raw)
        return core.profiles.create({
          name: name ?? parsed.profile.name,
          notes: parsed.profile.notes,
          proxy: parsed.profile.proxy,
          fingerprint: parsed.profile.fingerprint,
          launch: parsed.profile.launch,
        })
      },
    },

    groups: {
      list: async () => [...groupsById.values()],
      create: async name => {
        const group = { id: randomUUID(), name, createdAt: now() }
        groupsById.set(group.id, group)
        return group
      },
      rename: async (id, name) => {
        const group = groupsById.get(id)
        if (!group) throw new Error(`fake core: unknown group ${id}`)
        const next = { ...group, name }
        groupsById.set(id, next)
        return next
      },
      remove: async id => {
        groupsById.delete(id)
      },
    },

    runtime: {
      list: () => [...runtimeById.values()],

      get: id => runtimeById.get(id) ?? stoppedRuntime(id),

      launch: async id => {
        const profile = requireProfile(id)
        const runtime = {
          profileId: profile.id,
          status: 'running',
          pid: 4242,
          wsEndpoint: 'ws://127.0.0.1:5555/playwright',
          startedAt: now(),
          lastError: null,
        }
        runtimeById.set(id, runtime)
        emit(runtime)
        return runtime
      },

      stop: async id => {
        const runtime = stoppedRuntime(id)
        runtimeById.set(id, runtime)
        emit(runtime)
        return runtime
      },

      on: (_event, callback) => {
        runtimeSubscribers.add(callback)
        return () => runtimeSubscribers.delete(callback)
      },
    },

    kernel: {
      info: async () => kernelInfo,

      install: async () => {
        core.installCalls += 1
        if (core.installDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, core.installDelayMs))
        }
        for (const progress of core.installProgress) {
          for (const subscriber of kernelSubscribers) subscriber(progress)
        }
        if (core.installError) throw core.installError
        return kernelInfo
      },

      on: (_event, callback) => {
        kernelSubscribers.add(callback)
        return () => kernelSubscribers.delete(callback)
      },
    },

    close: async () => {
      core.closed = true
    },

    emitRuntime: emit,

    setRuntime: (profileId, patch) => {
      const next = { ...core.runtime.get(profileId), ...patch, profileId }
      runtimeById.set(profileId, next)
      emit(next)
      return next
    },
  }

  return core
}
