/**
 * Wiring: store + runtime registry + kernel manager behind the frozen `Core` surface.
 */

import type { Profile } from '@vfox/shared'
import { importProfileZip, writeProfileZip } from './archive.js'
import { createIdentity, identityInputs, identityIsCurrent } from './identity.js'
import type {
  Core,
  CoreLogger,
  CoreOptions,
  GroupsApi,
  KernelApi,
  ProfilesApi,
  RuntimeApi,
} from './index.js'
import { KernelManager, applyKernelDir } from './kernel.js'
import { launchCamoufox } from './launcher.js'
import { combineLoggers, createFileLogger } from './log.js'
import { reconcileOrphans } from './orphans.js'
import { RuntimeRegistry } from './runtime.js'
import { Store } from './store.js'

export async function createCoreImpl(options: CoreOptions): Promise<Core> {
  // Must happen before any camoufox-js import: it resolves its install directory at module load.
  applyKernelDir(options.kernelDir)

  const dataDir = options.dataDir
  // The file log is written by the core itself, whatever the embedding application supplies, because
  // with zero telemetry it is the only diagnostic channel the product has.
  const logger = combineLoggers(createFileLogger(dataDir), options.logger)

  const store = new Store(dataDir, logger)
  await store.load()

  // Engine processes from a previous run still hold their profile's parent.lock, which would make
  // the next launch of that profile fail with "profile in use".
  try {
    await reconcileOrphans({ dataDir: store.dataDir, logger })
  } catch (error) {
    logger.warn(`orphan reconciliation failed: ${message(error)}`)
  }

  const registry = new RuntimeRegistry({
    launch: launchCamoufox,
    resolveProfile: async id => store.getProfile(id),
    userDataDir: id => store.userDataDir(id),
    profileIds: () => store.profileIds(),
    logger,
  })
  const kernelManager = new KernelManager({ kernelDir: options.kernelDir, logger })

  /**
   * Guarantee a stored device identity before a profile is launched.
   *
   * The identity is generated once and re-injected on every launch; this only runs when it is
   * missing (a profile created by an older build) or stale (the engine version changed), and it
   * persists the result so the device a user sees is the device they keep.
   */
  async function ensureIdentity(id: string): Promise<Profile> {
    const profile = store.requireProfile(id)
    const engine = (await kernelManager.info()).version
    if (identityIsCurrent(profile, engine)) {
      return profile
    }
    const created = await createIdentity(profile.fingerprint, engine)
    logger.info(`profile ${id}: generated a device identity (engine ${engine ?? 'unknown'})`)
    return store.applyIdentity(id, created.identity, {
      config: created.config,
      webgl: created.webgl,
    })
  }

  const profiles: ProfilesApi = {
    list: async () => store.listProfiles(),
    get: async id => store.getProfile(id),
    async create(input) {
      const profile = await store.createProfile(input)
      const engine = (await kernelManager.info()).version
      const created = await createIdentity(profile.fingerprint, engine)
      logger.info(`profile ${profile.id}: created with a generated device identity`)
      return store.applyIdentity(profile.id, created.identity, {
        config: created.config,
        webgl: created.webgl,
      })
    },
    async update(id, patch) {
      const before = store.requireProfile(id)
      const updated = await store.updateProfile(id, patch)
      // The identity describes the device browserforge generated. Editing the fields it was
      // generated from means the user wants a different device, so the identity is dropped and
      // re-rolled once on the next launch. Editing anything else must not re-roll it.
      if (identityInputs(updated.fingerprint) !== identityInputs(before.fingerprint)) {
        logger.info(`profile ${id}: device identity inputs changed, re-rolling on next launch`)
        return store.applyIdentity(id, null)
      }
      return updated
    },
    async remove(id) {
      // Windows refuses to delete a directory a running browser still holds open.
      const status = registry.get(id).status
      if (status === 'running' || status === 'starting' || status === 'stopping') {
        await registry.stop(id)
      }
      await store.removeProfile(id)
      registry.forget(id)
    },
    clone: (id, name) => store.cloneProfile(id, name),
    userDataDir: id => store.userDataDir(id),
    async exportZip(id, destFile) {
      const profile = store.requireProfile(id)
      await writeProfileZip(profile, store.userDataDir(id), destFile)
    },
    importZip: (zipFile, name) =>
      importProfileZip(zipFile, name, (profile, fill) => store.insertProfile(profile, fill)),
  }

  const groups: GroupsApi = {
    list: async () => store.listGroups(),
    create: name => store.createGroup(name),
    rename: (id, name) => store.renameGroup(id, name),
    remove: id => store.removeGroup(id),
  }

  const runtime: RuntimeApi = {
    list: () => registry.list(),
    get: id => registry.get(id),
    async launch(id) {
      await ensureIdentity(id)
      return registry.launch(id)
    },
    stop: id => registry.stop(id),
    on: (_event, listener) => registry.on('change', listener),
  }

  const kernel: KernelApi = {
    info: () => kernelManager.info(),
    install: () => kernelManager.install(),
    on: (_event, listener) => kernelManager.on('progress', listener),
  }

  return {
    dataDir: store.dataDir,
    profiles,
    groups,
    runtime,
    kernel,
    async close() {
      await registry.closeAll()
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
