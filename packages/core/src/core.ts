/**
 * Wiring: store + runtime registry + kernel manager behind the frozen `Core` surface.
 */

import type { Profile, ProfileAddon } from '@vfox/shared'
import { CookieImportResultSchema, FingerprintSchema, ProfileBatchCreateSchema } from '@vfox/shared'
import { installAddon, listAddons, listEngineAddons, removeAddon } from './addons.js'
import { importProfileZip, writeProfileZip } from './archive.js'
import { cookieDbPath, readJar, writeJar } from './cookies.js'
import { createIdentity, identityInputs, identityIsCurrent, webglPairKey } from './identity.js'

import type {
  AddonsApi,
  CookiesApi,
  Core,
  CoreOptions,
  GroupsApi,
  KernelApi,
  ProfilesApi,
  RuntimeApi,
} from './index.js'
import { applyKernelDir, KernelManager, resolveEngineDir } from './kernel.js'
import { launchCamoufox } from './launcher.js'
import { createFileLogger } from './log.js'
import { formatNetscape, parseNetscape } from './netscape.js'
import { acquireDataDirLock, reconcileOrphans } from './orphans.js'
import { RuntimeRegistry } from './runtime.js'
import { type BatchEntry, Store } from './store.js'

export async function createCoreImpl(options: CoreOptions): Promise<Core> {
  // Must happen before any camoufox-js import: it resolves its install directory at module load.
  applyKernelDir(options.kernelDir)

  const dataDir = options.dataDir
  // ONE SINK PER LOG LINE. The core writes its own file log when the embedding application supplies
  // none - with zero telemetry that file is the only diagnostic channel the product has. When a logger
  // IS supplied, it owns the sink: the desktop passes a file logger pointed at this very directory, so
  // combining the two wrote every line twice, in two formats, into one file (measured in a user's log:
  // 'INFO vfox api listening' immediately followed by 'INFO  vfox api listening'). Server and hub
  // messages still reach the file through the logger the desktop hands to startServer.
  const logger = options.logger ?? createFileLogger(dataDir)

  /**
   * Whether the store may write while reading.
   *
   * A store READ can repair a corrupt table, and a repair is a rename plus a rewrite. This starts
   * false and is set from the lock once it is settled, so an instance that was refused the data
   * directory — and told "this instance is read-only and will not write the store" — cannot write it
   * through a repair either.
   */
  let mayWriteStore = false
  const store = new Store(dataDir, logger, { mayRepair: () => mayWriteStore })

  /**
   * The WebGL pairs the stored profiles already report.
   *
   * `createIdentity` draws from a table of 32 pairs with a weighted draw in which one NVIDIA row is
   * 45%, so without this two profiles are handed the same GPU often enough to matter — see the
   * comment on `pinWebgl`. Reading the store is cheap and it is the only place that knows what has
   * already been given out.
   */
  async function takenWebglPairs(): Promise<Set<string>> {
    const taken = new Set<string>()
    for (const profile of await store.listProfiles()) {
      const webgl = profile.fingerprint.webgl
      if (webgl) {
        taken.add(webglPairKey(webgl))
      }
    }
    return taken
  }
  // Engine processes from a previous run still hold their profile's parent.lock, which would make
  // the next launch of that profile fail with "profile in use". Only the instance that owns the
  // data directory may do that: a second instance must never kill the first one's running profiles.
  const dataDirLock = await acquireDataDirLock(store.dataDir, logger)
  // Settled before anything reads the store, because a read can repair a corrupt table and that is a
  // write. A refused instance still reads the recovered rows; it just leaves the files alone.
  mayWriteStore = dataDirLock.acquired
  if (dataDirLock.acquired) {
    try {
      await reconcileOrphans({ dataDir: store.dataDir, logger })
    } catch (error) {
      logger.warn(`orphan reconciliation failed: ${message(error)}`)
    }
  }

  // Loaded AFTER the lock is settled, deliberately. `load()` validates both tables, and a corrupt one
  // is repaired by writing the backup over it — so loading first would let an instance that was just
  // refused the directory repair the store it promised not to write.
  await store.load()

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
    const profile = await store.requireProfile(id)
    const engine = (await kernelManager.info()).version
    if (identityIsCurrent(profile, engine)) {
      return profile
    }
    if (profile.identity) {
      // One clear line so an engine swap is diagnosable from the log alone: which version moved, and
      // that this profile's device identity was re-rolled because of it. Any config key the new
      // engine no longer accepts is named separately by the launcher when the profile launches.
      logger.warn(
        `engine changed ${profile.identity.engine ?? '(unknown)'} -> ${engine ?? '(unknown)'}; ` +
          `regenerating the device identity of profile ${id} against the new engine`,
      )
    }
    const created = await createIdentity(
      profile.fingerprint,
      engine,
      await takenWebglPairs(),
      options.workArea,
    )
    logger.info(`profile ${id}: generated a device identity (engine ${engine ?? 'unknown'})`)
    return store.applyIdentity(id, created.identity, {
      config: created.config,
      webgl: created.webgl,
    })
  }

  // Reads pass, writes refuse: a second instance on one data directory must not write the store, and
  // above all must not put a browser on a profile the owner may already have open. The holder is named
  // so the refusal is actionable; a stale lock never reaches here, acquireDataDirLock takes it over.
  const requireWriteAccess = (action: string) => {
    if (!dataDirLock.acquired) {
      throw new Error(
        `cannot ${action}: another VFox instance (pid ${dataDirLock.owner ?? 'unknown'}) owns ` +
          ` ${store.dataDir} - this instance is read-only. Close the other instance, or point this one ` +
          'at a different data directory.',
      )
    }
  }

  const profiles: ProfilesApi = {
    list: async () => store.listProfiles(),
    get: async id => store.getProfile(id),
    async create(input) {
      requireWriteAccess('create a profile')
      const profile = await store.createProfile(input)
      const engine = (await kernelManager.info()).version
      const created = await createIdentity(
        profile.fingerprint,
        engine,
        await takenWebglPairs(),
        options.workArea,
      )
      logger.info(`profile ${profile.id}: created with a generated device identity`)
      return store.applyIdentity(profile.id, created.identity, {
        config: created.config,
        webgl: created.webgl,
      })
    },
    async createBatch(input) {
      requireWriteAccess('create profiles')
      const batch = ProfileBatchCreateSchema.parse(input)
      const engine = (await kernelManager.info()).version
      // The fingerprint constraints are shared, the *device* is not: `createIdentity` runs
      // browserforge's generator once per profile, so twenty profiles on the same platform and proxy
      // are twenty different machines rather than twenty copies of one.
      const fingerprint = FingerprintSchema.parse(batch.fingerprint ?? {})
      // One set for the whole batch, added to as it goes. De-duplicating against the store alone
      // would still let the profiles of this batch collide with each other — which is precisely the
      // case a user creating twenty accounts hits.
      const taken = await takenWebglPairs()
      const entries: BatchEntry[] = []
      for (let index = 0; index < batch.count; index += 1) {
        const created = await createIdentity(fingerprint, engine, taken, options.workArea)
        if (created.webgl) {
          taken.add(webglPairKey(created.webgl))
        }
        entries.push({
          input: {
            name: `${batch.namePrefix} ${index + 1}`,
            ...(batch.groupId === undefined ? {} : { groupId: batch.groupId }),
            ...(batch.proxy === undefined ? {} : { proxy: batch.proxy }),
            ...(batch.launch === undefined ? {} : { launch: batch.launch }),
            ...(batch.fingerprint === undefined ? {} : { fingerprint: batch.fingerprint }),
          },
          identity: created.identity,
          config: created.config,
          webgl: created.webgl,
        })
      }
      const profiles = await store.createProfiles(entries)
      logger.info(
        `created ${profiles.length} profiles in one batch ("${batch.namePrefix} 1".."${batch.namePrefix} ${batch.count}")`,
      )
      return profiles
    },
    async update(id, patch) {
      requireWriteAccess('update a profile')
      const before = await store.requireProfile(id)
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
      requireWriteAccess('remove a profile')
      // Windows refuses to delete a directory a running browser still holds open.
      const status = registry.get(id).status
      if (status === 'running' || status === 'starting' || status === 'stopping') {
        await registry.stop(id)
      }
      await store.removeProfile(id)
      registry.forget(id)
    },
    clone: (id, name) => {
      requireWriteAccess('clone a profile')
      return store.cloneProfile(id, name)
    },
    userDataDir: id => store.userDataDir(id),
    async exportZip(id, destFile) {
      const profile = await store.requireProfile(id)
      await writeProfileZip(profile, store.userDataDir(id), destFile)
    },
    importZip: (zipFile, name) => {
      requireWriteAccess('import a profile')
      return importProfileZip(zipFile, name, (profile, fill) => store.insertProfile(profile, fill))
    },
  }

  const groups: GroupsApi = {
    list: async () => store.listGroups(),
    create: name => {
      requireWriteAccess('create a group')
      return store.createGroup(name)
    },
    rename: (id, name) => {
      requireWriteAccess('rename a group')
      return store.renameGroup(id, name)
    },
    remove: id => {
      requireWriteAccess('remove a group')
      return store.removeGroup(id)
    },
  }

  const runtime: RuntimeApi = {
    list: () => registry.list(),
    get: id => registry.get(id),
    async launch(id) {
      // The corruption path this lock exists for: two browsers on one profile directory.
      requireWriteAccess('launch a profile')
      await ensureIdentity(id)
      return registry.launch(id)
    },
    stop: id => {
      requireWriteAccess('stop a profile')
      return registry.stop(id)
    },
    on: (_event, listener) => registry.on('change', listener),
  }

  const kernel: KernelApi = {
    info: () => kernelManager.info(),
    install: () => kernelManager.install(),
    on: (_event, listener) => kernelManager.on('progress', listener),
  }

  const cookies: CookiesApi = {
    async export(id) {
      const profile = await store.requireProfile(id)
      requireStoppedForCookies(registry, profile)
      const jar = await readJar(cookieDbPath(store.userDataDir(id)))
      return {
        content: formatNetscape(jar.cookies),
        cookies: jar.cookies.length,
        skipped: jar.skipped,
        hasCookieStore: jar.hasStore,
      }
    },

    async import(id, content, options) {
      const profile = await store.requireProfile(id)
      requireStoppedForCookies(registry, profile)

      const mode = options?.mode ?? 'merge'
      const parsed = parseNetscape(content)
      if (parsed.cookies.length === 0 && parsed.skipped.length > 0) {
        // Writing nothing and reporting success would look like a working import of an empty file.
        throw new Error(
          `No usable cookies in that file — ${parsed.skipped.length} line(s) could not be read ` +
            `(line ${parsed.skipped[0]?.line ?? '?'}: ${parsed.skipped[0]?.reason ?? 'unknown'})`,
        )
      }

      const written = await writeJar(cookieDbPath(store.userDataDir(id)), parsed.cookies, mode)
      logger.info(
        `profile ${id}: imported ${written.written} cookie(s) (${mode}` +
          `${written.removed > 0 ? `, ${written.removed} removed first` : ''}), ` +
          `${parsed.skipped.length} line(s) skipped`,
      )

      return CookieImportResultSchema.parse({
        profileId: id,
        mode,
        parsed: parsed.cookies.length,
        written: written.written,
        updated: written.updated,
        removed: written.removed,
        skipped: parsed.skipped,
      })
    },
  }

  const addons: AddonsApi = {
    async list(id) {
      const profile = await store.requireProfile(id)
      // Deliberately NOT `requireStoppedForAddons`: this store is our own inert directory that no
      // browser holds open, so disk is authoritative even while the profile runs. The cookie export
      // refuses for the opposite reason — a live browser owns `cookies.sqlite` — and copying that
      // rule here would only stop the UI from listing a running profile's addons.
      const installed = await listAddons(store.userDataDir(profile.id))
      return [...installed, ...(await engineAddons())]
    },

    async install(id, sourcePath, options) {
      const profile = await store.requireProfile(id)
      requireStoppedForAddons(registry, profile)
      const installed = await installAddon(store.userDataDir(id), sourcePath, options)
      logger.info(
        `profile ${id}: installed addon ${installed.slug} (${installed.name} ${installed.version}, ` +
          `${installed.files} file(s))`,
      )
      return installed
    },

    async remove(id, slugOrId) {
      const profile = await store.requireProfile(id)
      requireStoppedForAddons(registry, profile)
      const removed = await removeAddon(store.userDataDir(id), slugOrId)
      logger.info(`profile ${id}: removed addon ${removed.slug} (${removed.name})`)
      return removed
    },
  }

  return {
    dataDir: store.dataDir,
    dataDirLock: { owned: dataDirLock.acquired, owner: dataDirLock.owner },
    profiles,
    groups,
    runtime,
    kernel,
    cookies,
    addons,
    async close() {
      await registry.closeAll()
      await dataDirLock.release()
    },
  }
}

/**
 * The engine ships addons of its own and camoufox-js appends them to every launch, so they are part
 * of what a profile loads whether or not the user asked. Reading them is best-effort: a missing or
 * unreadable engine directory must not make `addons.list` fail, it just means there is nothing to
 * report.
 */
async function engineAddons(): Promise<ProfileAddon[]> {
  try {
    return await listEngineAddons(await resolveEngineDir())
  } catch {
    return []
  }
}

/**
 * Addons are read at launch and baked into the engine's environment, so the profile must not be
 * running when the store changes. `error` is allowed through for the same reason as cookies: the
 * registry only reaches it with no live process attached, and refusing would strand a profile whose
 * launch failed.
 */
function requireStoppedForAddons(registry: RuntimeRegistry, profile: Profile): void {
  const { status } = registry.get(profile.id)
  if (status !== 'stopped' && status !== 'error') {
    throw new Error(
      `Profile "${profile.name}" is ${status} — stop it before installing or removing addons. ` +
        'The engine reads the addon list when it starts, so a change now would only take effect ' +
        'after a restart, and removing one could delete files the browser has loaded.',
    )
  }
}

/**
 * Cookie files are the on-disk jar, so the browser must not be holding it. `error` is allowed
 * through: the registry only reaches it with no live process attached (`pid: null`), and refusing
 * would strand a profile whose launch failed.
 */
function requireStoppedForCookies(registry: RuntimeRegistry, profile: Profile): void {
  const { status } = registry.get(profile.id)
  if (status !== 'stopped' && status !== 'error') {
    throw new Error(
      `Profile "${profile.name}" is ${status} — stop it before exporting or importing cookies`,
    )
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
