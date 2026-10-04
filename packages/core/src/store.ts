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
 * Durability rules:
 *   - every write is a full temp file followed by a rename, and the rename is retried: Windows
 *     `MoveFileEx` fails with EPERM/EBUSY while antivirus, the search indexer or a sync client
 *     holds a handle on the destination;
 *   - the previous generation is kept as `.bak` before it is replaced;
 *   - a file that fails validation is never silently replaced by an empty store. It is quarantined
 *     and the `.bak` is restored when it validates; if it does not, loading fails loudly and the
 *     corrupt file is left exactly where it is so the next start fails loudly too.
 *
 * Writes are serialised through a promise chain so two concurrent requests can never interleave
 * and lose an entry, and every read validates the shared zod schemas.
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

  #profiles: Profile[] = []
  #groups: Group[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #logger: CoreLogger | undefined

  constructor(dataDir: string, logger?: CoreLogger) {
    this.dataDir = path.resolve(dataDir)
    this.profilesFile = path.join(this.dataDir, 'profiles.json')
    this.groupsFile = path.join(this.dataDir, 'groups.json')
    this.#logger = logger
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    this.#profiles = await this.#readTable(this.profilesFile, ProfileSchema, 'profile')
    this.#groups = await this.#readTable(this.groupsFile, GroupSchema, 'group')
  }

  /* ------------------------------------------------------------------------- profiles */

  listProfiles(): Profile[] {
    return this.#profiles.map(clone)
  }

  getProfile(id: string): Profile | undefined {
    const profile = this.#profiles.find(item => item.id === id)
    return profile ? clone(profile) : undefined
  }

  requireProfile(id: string): Profile {
    const profile = this.getProfile(id)
    if (!profile) {
      throw new Error(`Unknown profile: ${id}`)
    }
    return profile
  }

  profileIds(): string[] {
    return this.#profiles.map(profile => profile.id)
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
      this.#profiles.push(profile)
      await this.#persistProfiles()
      return clone(profile)
    })
  }

  /**
   * Create a whole batch of profiles, all or nothing.
   *
   * Strategy: every entry is validated and built into a `Profile` **before any I/O**, so a bad entry
   * at position 7 of 20 cannot leave six profiles behind — it fails before a single directory exists.
   * The directories are then created, and the table is written exactly **once**, through the same
   * atomic temp-file-plus-rename path a single profile uses. If the write fails, the profiles are
   * removed from memory and their directories deleted, so the store is byte-for-byte what it was.
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

      this.#profiles.push(...profiles)
      try {
        await this.#persistProfiles()
      } catch (error) {
        const ids = new Set(profiles.map(profile => profile.id))
        this.#profiles = this.#profiles.filter(profile => !ids.has(profile.id))
        await removeDirectories()
        throw error
      }
      return profiles.map(clone)
    })
  }

  async updateProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
    return this.#enqueue(async () => {
      const current = this.requireProfile(id)
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
      this.#profiles = this.#profiles.map(item => (item.id === id ? updated : item))
      await this.#persistProfiles()
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
      const current = this.requireProfile(id)
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
      this.#profiles = this.#profiles.map(item => (item.id === id ? updated : item))
      await this.#persistProfiles()
      return clone(updated)
    })
  }

  /** Removes the profile from the table first, then its directory. */
  async removeProfile(id: string): Promise<void> {
    return this.#enqueue(async () => {
      this.requireProfile(id)
      this.#profiles = this.#profiles.filter(item => item.id !== id)
      await this.#persistProfiles()
      await fs.rm(this.profileDir(id), { recursive: true, force: true })
    })
  }

  async cloneProfile(id: string, name?: string): Promise<Profile> {
    const source = this.requireProfile(id)
    const now = new Date().toISOString()
    const copy = ProfileSchema.parse({
      ...source,
      id: randomUUID(),
      name: name ?? `${source.name} copy`,
      createdAt: now,
      updatedAt: now,
    })
    await this.#materialise(copy, async userDataDir => {
      const from = this.userDataDir(id)
      if (await exists(from)) {
        await fs.cp(from, userDataDir, { recursive: true })
      }
    })
    return copy
  }

  /**
   * Insert an externally produced profile (a zip import), filling its data directory first.
   * A failure while filling removes the half-written directory and leaves the table untouched.
   */
  async insertProfile(
    profile: Profile,
    fillUserDataDir?: (userDataDir: string) => Promise<void>,
  ): Promise<Profile> {
    const validated = ProfileSchema.parse(profile)
    return this.#materialise(validated, fillUserDataDir)
  }

  /* --------------------------------------------------------------------------- groups */

  listGroups(): Group[] {
    return this.#groups.map(group => ({ ...group }))
  }

  async createGroup(name: string): Promise<Group> {
    return this.#enqueue(async () => {
      const group = GroupSchema.parse({
        id: randomUUID(),
        name: requireName(name, 'Group'),
        createdAt: new Date().toISOString(),
      })
      this.#groups.push(group)
      await this.#persistGroups()
      return { ...group }
    })
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    return this.#enqueue(async () => {
      const current = this.#groups.find(group => group.id === id)
      if (!current) {
        throw new Error(`Unknown group: ${id}`)
      }
      const updated: Group = { ...current, name: requireName(name, 'Group') }
      this.#groups = this.#groups.map(group => (group.id === id ? updated : group))
      await this.#persistGroups()
      return { ...updated }
    })
  }

  /** Removing a group un-groups its profiles rather than orphaning them. */
  async removeGroup(id: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#groups.some(group => group.id === id)) {
        throw new Error(`Unknown group: ${id}`)
      }
      this.#groups = this.#groups.filter(group => group.id !== id)
      const now = new Date().toISOString()
      this.#profiles = this.#profiles.map(profile =>
        profile.groupId === id ? { ...profile, groupId: null, updatedAt: now } : profile,
      )
      await this.#persistGroups()
      await this.#persistProfiles()
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

  async #materialise(
    profile: Profile,
    fillUserDataDir?: (userDataDir: string) => Promise<void>,
  ): Promise<Profile> {
    const dir = this.profileDir(profile.id)
    await fs.mkdir(dir, { recursive: true })
    try {
      await fillUserDataDir?.(this.userDataDir(profile.id))
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true })
      throw error
    }
    this.#profiles.push(profile)
    try {
      await this.#persistProfiles()
    } catch (error) {
      this.#profiles = this.#profiles.filter(item => item.id !== profile.id)
      throw error
    }
    return clone(profile)
  }

  async #persistProfiles(): Promise<void> {
    await writeJson(this.profilesFile, this.#profiles)
  }

  async #persistGroups(): Promise<void> {
    await writeJson(this.groupsFile, this.#groups)
  }

  /**
   * Read one JSON table, recovering from a `.bak` when the file is unusable.
   *
   * A corrupt file with a valid backup is quarantined and restored — loudly. A corrupt file with
   * no usable backup throws and is left in place, so the failure cannot be mistaken for "no
   * profiles yet".
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

  /** Serialises mutating operations so concurrent callers cannot lose each other's writes. */
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
