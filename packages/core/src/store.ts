/**
 * Plain-JSON profile store.
 *
 * Layout (deliberately readable, diffable and copyable with ordinary tools):
 *
 *   <dataDir>/profiles.json               Profile[] — the whole profile table
 *   <dataDir>/profiles.json.bak           the previous generation, kept for recovery
 *   <dataDir>/groups.json                 Group[]
 *   <dataDir>/profiles/<id>/userdata      the profile's isolated browser data directory
 *
 * ## There is no in-memory table
 *
 * Every read goes to disk. The store is *shared* state between the desktop app, `vfox serve` and
 * every `vfox create` / `vfox rm` the user runs, so a process that caches it is wrong the moment
 * another process writes — and the failure is silent: the profile is on disk, `vfox list` sees it,
 * and the API insists it does not exist.
 *
 * The cost was measured rather than assumed, on a real 200-profile store (162 KiB `profiles.json`,
 * 1000 calls each, warm cache):
 *
 *   list()   in memory + structuredClone   723 µs  ->  read per call  2648 µs  (3.7x)
 *   get(id)  in memory find + clone         15 µs  ->  read per call  1502 µs  (102x)
 *
 * which is ~2.6% of one core at 10 requests/second — invisible next to a browser launch. Note the
 * first line: the old "cache" was not a fast path either, because `list()` deep-cloned every
 * profile, so the real regression is 3.7x on `list()` and a millisecond and a half on `get()`.
 *
 * Three cheaper-looking alternatives were considered and rejected, each for a correctness argument
 * rather than a performance one:
 *   - `fs.watch` + reload: makes reads *eventually* consistent instead of immediately consistent, so
 *     `vfox create` followed straight away by `GET /profiles` can still miss. Every write replaces
 *     the file by rename, so it would need a directory watcher, debounce and suppression of our own
 *     writes — and tests of it become timing-dependent.
 *   - a `stat`-gated memo (`ino`/`mtimeMs`/`size`): would be *faster* than the old cache, but adds a
 *     validity argument about timestamp granularity to save time nobody can feel.
 *   - a request-scoped cache: `packages/core` has no request, so it would mean threading a context
 *     through the frozen `Core` surface for one read per request.
 *
 * ## Writes are read-modify-write
 *
 * Every mutation re-reads its table inside the queue, applies the change to *that* array and writes
 * it back. Without this, live reads alone would have made the bug look fixed while the write kept
 * clobbering: the server would hold a stale table, `vfox create Alpha` would write it, and the
 * server's next write would delete Alpha from disk.
 *
 * ## What is still not safe
 *
 * Two *processes* writing at once can still lose one, because the read and the rename are not
 * atomic. The window is one mutation — measured at ~8 ms for a 200-profile table, since every write
 * rewrites the whole file. Closing it needs a cross-process lock, which brings stale-lock recovery
 * after a crash and a CLI that blocks while the GUI holds the lock; the documented workflow is one
 * server plus occasional CLI writes, so the residual window is recorded here rather than fixed. Two
 * `vfox serve` instances on one data directory can therefore still lose a simultaneous write.
 *
 * Durability rules:
 *   - every write is a full temp file followed by a rename, and the rename is retried: Windows
 *     `MoveFileEx` fails with EPERM/EBUSY while antivirus, the search indexer or a sync client
 *     holds a handle on the destination;
 *   - the previous generation is kept as `.bak` before it is replaced;
 *   - a file that fails validation is never silently replaced by an empty store. It is quarantined
 *     and the `.bak` is restored when it validates; if it does not, loading fails loudly and the
 *     corrupt file is left exactly where it is so the next start fails loudly too.
 *
 * Every public method runs through one queue, reads included. That is what keeps a repair triggered
 * by a read (a `.bak` restore) from interleaving with a mutation, and it is why the internal
 * helpers never queue themselves — the queue is not re-entrant.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type FingerprintIdentity,
  type Group,
  GroupSchema,
  type Profile,
  type ProfileCreate,
  ProfileCreateSchema,
  ProfileSchema,
  type ProfileUpdate,
  ProfileUpdateSchema,
  type WebglPair,
} from '@vfox/shared'
import type { CoreLogger } from './index.js'

/** Minimal structural view of a zod schema, so this module needs no zod import of its own. */
interface Parser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } }
}

/** One profile of a batch: the caller's input plus the identity generated for it. */
export interface BatchEntry {
  input: ProfileCreate
  identity: FingerprintIdentity
  /** The identity's pinned config keys, merged into `fingerprint.config`. */
  config: Record<string, unknown>
  webgl: WebglPair | undefined
}

const RENAME_ATTEMPTS = 10
const RENAME_RETRY_MS = 20
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

export class Store {
  readonly dataDir: string
  readonly profilesFile: string
  readonly groupsFile: string

  #queue: Promise<unknown> = Promise.resolve()
  #logger: CoreLogger | undefined
  /**
   * Whether this instance may WRITE while reading.
   *
   * A store read can repair a corrupt table, and a repair is a rename plus a rewrite. A core that was
   * refused the data-directory lock is told "this instance is read-only and will not write the store",
   * so it must not repair either — otherwise the promise is false and a second instance can rewrite
   * `profiles.json` while the owner is writing it. It still READS the recovered rows; it leaves the
   * files exactly as they are and says so.
   */
  #mayRepair: () => boolean

  constructor(dataDir: string, logger?: CoreLogger, options: { mayRepair?: () => boolean } = {}) {
    this.dataDir = path.resolve(dataDir)
    this.profilesFile = path.join(this.dataDir, 'profiles.json')
    this.groupsFile = path.join(this.dataDir, 'groups.json')
    this.#logger = logger
    // Default true: every caller that does not own a lock concept — the tests, the scripts, a single
    // core — keeps the previous behaviour, and only the core passes a predicate.
    this.#mayRepair = options.mayRepair ?? (() => true)
  }

  /**
   * Prepare the data directory and validate both tables once, so a corrupt store refuses to start
   * loudly instead of failing on the first request.
   */
  async load(): Promise<void> {
    await this.#enqueue(async () => {
      await fs.mkdir(this.dataDir, { recursive: true })
      await this.#readProfiles()
      await this.#readGroups()
    })
  }

  /* ------------------------------------------------------------------------- profiles */

  async listProfiles(): Promise<Profile[]> {
    return this.#enqueue(async () => (await this.#readProfiles()).map(clone))
  }

  async getProfile(id: string): Promise<Profile | undefined> {
    return this.#enqueue(async () => {
      const profile = (await this.#readProfiles()).find(item => item.id === id)
      return profile ? clone(profile) : undefined
    })
  }

  async requireProfile(id: string): Promise<Profile> {
    const profile = await this.getProfile(id)
    if (!profile) {
      throw new Error(`Unknown profile: ${id}`)
    }
    return profile
  }

  async profileIds(): Promise<string[]> {
    return this.#enqueue(async () => (await this.#readProfiles()).map(profile => profile.id))
  }

  async createProfile(input: ProfileCreate): Promise<Profile> {
    return this.#enqueue(async () => {
      const draft = ProfileCreateSchema.parse(input)
      const now = new Date().toISOString()
      const profile = ProfileSchema.parse({
        id: randomUUID(),
        name: draft.name,
        groupId: draft.groupId ?? null,
        notes: draft.notes ?? '',
        color: draft.color ?? null,
        proxy: draft.proxy ?? null,
        fingerprint: draft.fingerprint ?? {},
        identity: null,
        launch: draft.launch ?? {},
        createdAt: now,
        updatedAt: now,
      })
      const table = await this.#readProfiles()
      table.push(profile)
      await this.#persistProfiles(table)
      return clone(profile)
    })
  }

  /**
   * Create a whole batch of profiles, all or nothing.
   *
   * Strategy: every entry is validated and built into a `Profile` **before any I/O**, so a bad entry
   * at position 7 of 20 cannot leave six profiles behind — it fails before a single directory exists.
   * The directories are then created, and the table is written exactly **once**, through the same
   * atomic temp-file-plus-rename path a single profile uses. If the write fails, the directories are
   * deleted and the table was never touched, so the store is byte-for-byte what it was.
   *
   * The alternative — writing each profile through `createProfile` and deleting the earlier ones on
   * failure — was rejected: it would need N atomic writes and N compensating deletes, and every one of
   * those is a place where a crash leaves the user with part of a batch and no record of which part.
   */
  async createProfiles(entries: BatchEntry[]): Promise<Profile[]> {
    return this.#enqueue(async () => {
      const now = new Date().toISOString()
      const profiles = entries.map(entry => {
        const draft = ProfileCreateSchema.parse(entry.input)
        return ProfileSchema.parse({
          id: randomUUID(),
          name: draft.name,
          groupId: draft.groupId ?? null,
          notes: draft.notes ?? '',
          color: draft.color ?? null,
          proxy: draft.proxy ?? null,
          fingerprint: {
            ...(draft.fingerprint ?? {}),
            config: entry.config,
            webgl: entry.webgl ?? null,
          },
          identity: entry.identity,
          launch: draft.launch ?? {},
          createdAt: now,
          updatedAt: now,
        })
      })

      const directories: string[] = []
      const removeDirectories = async () => {
        await Promise.all(
          directories.map(directory =>
            fs.rm(directory, { recursive: true, force: true }).catch(() => undefined),
          ),
        )
      }

      try {
        for (const profile of profiles) {
          const directory = this.profileDir(profile.id)
          await fs.mkdir(directory, { recursive: true })
          directories.push(directory)
        }
      } catch (error) {
        await removeDirectories()
        throw error
      }

      try {
        const table = await this.#readProfiles()
        table.push(...profiles)
        await this.#persistProfiles(table)
      } catch (error) {
        await removeDirectories()
        throw error
      }
      return profiles.map(clone)
    })
  }

  async updateProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
    return this.#enqueue(async () => {
      const table = await this.#readProfiles()
      const current = requireIn(table, id)
      const draft = ProfileUpdateSchema.parse(patch)
      const updated = ProfileSchema.parse({
        ...current,
        ...(draft.name === undefined ? {} : { name: draft.name }),
        ...(draft.groupId === undefined ? {} : { groupId: draft.groupId }),
        ...(draft.notes === undefined ? {} : { notes: draft.notes }),
        ...(draft.color === undefined ? {} : { color: draft.color }),
        ...(draft.proxy === undefined ? {} : { proxy: draft.proxy }),
        // `fingerprint`/`launch` patches are partial merges, and they merge the keys the caller
        // actually sent — not the parsed value. `FingerprintSchema.partial()` still applies the
        // inner `.default()`s, so the parsed object cannot tell "field omitted" from "field set to
        // its default", and merging it would silently reset os/screen/window on an unrelated edit.
        // The `ProfileSchema.parse` below validates whatever the caller sent either way.
        ...(patch.fingerprint === undefined
          ? {}
          : { fingerprint: { ...current.fingerprint, ...patch.fingerprint } }),
        ...(patch.launch === undefined ? {} : { launch: { ...current.launch, ...patch.launch } }),
        updatedAt: new Date().toISOString(),
      })
      await this.#persistProfiles(table.map(item => (item.id === id ? updated : item)))
      return clone(updated)
    })
  }

  /**
   * Set (or clear) the profile's stored device identity and pin the values that must not drift.
   *
   * Called once at creation and again when the identity is missing or stale, so it must be
   * idempotent and must never overwrite a config key the user already set.
   */
  async applyIdentity(
    id: string,
    identity: FingerprintIdentity | null,
    patch: { config?: Record<string, unknown>; webgl?: WebglPair } = {},
  ): Promise<Profile> {
    return this.#enqueue(async () => {
      const table = await this.#readProfiles()
      const current = requireIn(table, id)
      const updated = ProfileSchema.parse({
        ...current,
        identity,
        fingerprint: {
          ...current.fingerprint,
          // Only an explicit pair replaces the stored one; `undefined` leaves it alone.
          ...(patch.webgl === undefined ? {} : { webgl: patch.webgl }),
          config: { ...current.fingerprint.config, ...patch.config },
        },
        updatedAt: new Date().toISOString(),
      })
      await this.#persistProfiles(table.map(item => (item.id === id ? updated : item)))
      return clone(updated)
    })
  }

  /** Removes the profile from the table first, then its directory. */
  async removeProfile(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const table = await this.#readProfiles()
      requireIn(table, id)
      await this.#persistProfiles(table.filter(item => item.id !== id))
      await fs.rm(this.profileDir(id), { recursive: true, force: true })
    })
  }

  async cloneProfile(id: string, name?: string): Promise<Profile> {
    const source = await this.requireProfile(id)
    const now = new Date().toISOString()
    const copy = ProfileSchema.parse({
      ...source,
      id: randomUUID(),
      name: name ?? `${source.name} copy`,
      createdAt: now,
      updatedAt: now,
    })
    return this.#materialise(copy, async userDataDir => {
      const from = this.userDataDir(id)
      if (await exists(from)) {
        await fs.cp(from, userDataDir, { recursive: true })
      }
    })
  }

  /**
   * Insert an externally produced profile (a zip import), filling its data directory first.
   * A failure while filling removes the half-written directory and leaves the table untouched.
   */
  async insertProfile(
    profile: Profile,
    fillUserDataDir?: (userDataDir: string) => Promise<void>,
  ): Promise<Profile> {
    return this.#materialise(ProfileSchema.parse(profile), fillUserDataDir)
  }

  /* --------------------------------------------------------------------------- groups */

  async listGroups(): Promise<Group[]> {
    return this.#enqueue(async () => (await this.#readGroups()).map(group => ({ ...group })))
  }

  async createGroup(name: string): Promise<Group> {
    return this.#enqueue(async () => {
      const group = GroupSchema.parse({
        id: randomUUID(),
        name: requireName(name, 'Group'),
        createdAt: new Date().toISOString(),
      })
      const table = await this.#readGroups()
      table.push(group)
      await this.#persistGroups(table)
      return { ...group }
    })
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    return this.#enqueue(async () => {
      const table = await this.#readGroups()
      const current = table.find(group => group.id === id)
      if (!current) {
        throw new Error(`Unknown group: ${id}`)
      }
      const updated: Group = { ...current, name: requireName(name, 'Group') }
      await this.#persistGroups(table.map(group => (group.id === id ? updated : group)))
      return { ...updated }
    })
  }

  /** Removing a group un-groups its profiles rather than orphaning them. */
  async removeGroup(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const groups = await this.#readGroups()
      if (!groups.some(group => group.id === id)) {
        throw new Error(`Unknown group: ${id}`)
      }
      const profiles = await this.#readProfiles()
      const now = new Date().toISOString()
      await this.#persistGroups(groups.filter(group => group.id !== id))
      await this.#persistProfiles(
        profiles.map(profile =>
          profile.groupId === id ? { ...profile, groupId: null, updatedAt: now } : profile,
        ),
      )
    })
  }

  /* ---------------------------------------------------------------------------- paths */

  profileDir(id: string): string {
    return path.join(this.dataDir, 'profiles', id)
  }

  userDataDir(id: string): string {
    return path.join(this.profileDir(id), 'userdata')
  }

  /* -------------------------------------------------------------------------- private */

  /**
   * Create the directory, fill it, then add the row — all inside one queue slot, so two clones
   * cannot read the same table and have the second write erase the first.
   */
  #materialise(
    profile: Profile,
    fillUserDataDir?: (userDataDir: string) => Promise<void>,
  ): Promise<Profile> {
    return this.#enqueue(async () => {
      const dir = this.profileDir(profile.id)
      await fs.mkdir(dir, { recursive: true })
      try {
        await fillUserDataDir?.(this.userDataDir(profile.id))
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true })
        throw error
      }
      const table = await this.#readProfiles()
      table.push(profile)
      await this.#persistProfiles(table)
      return clone(profile)
    })
  }

  /** Internal reads. They assume the caller already holds the queue. */
  #readProfiles(): Promise<Profile[]> {
    return this.#readTable(this.profilesFile, ProfileSchema, 'profile')
  }

  #readGroups(): Promise<Group[]> {
    return this.#readTable(this.groupsFile, GroupSchema, 'group')
  }

  #persistProfiles(table: readonly Profile[]): Promise<void> {
    return writeJson(this.profilesFile, table)
  }

  #persistGroups(table: readonly Group[]): Promise<void> {
    return writeJson(this.groupsFile, table)
  }

  /**
   * Read one JSON table, recovering from a `.bak` when the file is unusable.
   *
   * A corrupt file with a valid backup is quarantined and restored — loudly. A corrupt file with
   * no usable backup throws and is left in place, so the failure cannot be mistaken for "no
   * profiles yet".
   *
   * Because reads now happen per call, this repair can run during a request. It is deliberately an
   * internal helper: every public entry point already holds the queue, so a repair can never
   * interleave with a mutation.
   */
  async #readTable<T>(file: string, schema: Parser<T>, label: string): Promise<T[]> {
    const raw = await readFileOrNull(file)
    if (raw === null) {
      return []
    }

    const parsed = parseTable(raw, schema, label)
    if (parsed.ok) {
      return parsed.value
    }

    const backup = `${file}.bak`
    const backupRaw = await readFileOrNull(backup)
    if (backupRaw !== null) {
      const recovered = parseTable(backupRaw, schema, label)
      if (recovered.ok) {
        if (!this.#mayRepair()) {
          this.#logger?.error(
            `${file} was invalid (${parsed.reason}); the backup at ${backup} parses, so its ` +
              `${recovered.value.length} entries are being read — but this instance does not own the ` +
              'data directory, so the files are left exactly as they are. Close the other VFox ' +
              'instance and start again to repair them.',
          )
          return recovered.value
        }
        const quarantine = `${file.replace(/\.json$/, '')}.corrupt-${timestamp()}.json`
        await fs.rename(file, quarantine)
        await writeJson(file, recovered.value)
        this.#logger?.error(
          `${file} was invalid (${parsed.reason}); restored from ${backup}. ` +
            `The corrupt file is kept at ${quarantine}`,
        )
        return recovered.value
      }
    }

    throw new Error(
      `${file} is invalid — ${parsed.reason}. Refusing to start with a corrupt profile store` +
        (backupRaw === null
          ? ' (no backup is available)'
          : ` (the backup at ${backup} is invalid too)`),
    )
  }

  /**
   * Serialises every operation — reads as well as writes — so concurrent callers cannot lose each
   * other's writes and a read-triggered repair cannot land in the middle of a mutation.
   * Internal helpers must never call this: the queue is not re-entrant.
   */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function clone(profile: Profile): Profile {
  return structuredClone(profile)
}

/** Look a profile up in a table the caller has already read, without a second read. */
function requireIn(table: readonly Profile[], id: string): Profile {
  const profile = table.find(item => item.id === id)
  if (!profile) {
    throw new Error(`Unknown profile: ${id}`)
  }
  return profile
}

function requireName(name: string, what: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error(`${what} name must not be empty`)
  }
  return trimmed
}

/** True when the path exists. A directory counts, so this must never read the file. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function parseTable<T>(
  raw: string,
  schema: Parser<T>,
  label: string,
): { ok: true; value: T[] } | { ok: false; reason: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `not valid JSON (${errorMessage(error)})` }
  }
  if (!Array.isArray(data)) {
    return { ok: false, reason: `expected a JSON array of ${label} objects` }
  }
  const value: T[] = []
  for (const [index, item] of data.entries()) {
    const result = schema.safeParse(item)
    if (!result.success) {
      return {
        ok: false,
        reason: `${label} at index ${index} is invalid — ${result.error.message}`,
      }
    }
    value.push(result.data)
  }
  return { ok: true, value }
}

/**
 * Atomic write: a full temp file, a copy of the previous generation as `.bak`, then a rename over
 * the target — retried, because a Windows rename fails while another process holds the file open.
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

  if (await exists(file)) {
    await fs.copyFile(file, `${file}.bak`)
  }
  await renameWithRetry(temp, file)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined || !RETRYABLE_CODES.has(code)) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS))
    }
  }
  throw lastError
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
