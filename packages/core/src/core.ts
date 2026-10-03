/**
 * Wiring: store + runtime registry + kernel manager behind the frozen `Core` surface.
 */

import fs from 'node:fs/promises'
import { importProfileZip, writeProfileZip } from './archive.js'
import type {
  Core,
  CoreLogger,
  CoreOptions,
  GroupsApi,
  KernelApi,
  ProfilesApi,
  RuntimeApi,
} from './index.js'
import { applyKernelDir, KernelManager } from './kernel.js'
import { launchCamoufox } from './launcher.js'
import { RuntimeRegistry } from './runtime.js'
import { Store } from './store.js'

const NOOP_LOGGER: CoreLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export async function createCoreImpl(options: CoreOptions): Promise<Core> {
  // Must happen before any camoufox-js import: it resolves its install directory at module load.
  applyKernelDir(options.kernelDir)

  const logger = options.logger ?? NOOP_LOGGER
  const store = new Store(options.dataDir)
  await fs.mkdir(store.dataDir, { recursive: true })
  await store.load()

  const registry = new RuntimeRegistry({
    launch: launchCamoufox,
    resolveProfile: async id => store.getProfile(id),
    userDataDir: id => store.userDataDir(id),
    profileIds: () => store.profileIds(),
    logger,
  })
  const kernelManager = new KernelManager({ kernelDir: options.kernelDir, logger })

  const profiles: ProfilesApi = {
    list: async () => store.listProfiles(),
    get: async id => store.getProfile(id),
    create: input => store.createProfile(input),
    update: (id, patch) => store.updateProfile(id, patch),
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
    launch: id => registry.launch(id),
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
