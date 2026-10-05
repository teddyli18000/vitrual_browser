/**
 * Frozen public surface of @vfox/core.
 *
 * This file is the contract every other package codes against (server, cli, desktop).
 * The implementation lives in ./core.ts; keep the exported signatures below stable.
 */

import type {
  CookieImportMode,
  CookieImportResult,
  CookieSkip,
  Group,
  KernelInfo,
  KernelProgress,
  Profile,
  ProfileBatchCreate,
  ProfileCreate,
  ProfileRuntime,
  ProfileUpdate,
} from '@vfox/shared'
import { createCoreImpl } from './core.js'

export interface CoreLogger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface CoreOptions {
  /** Root of all persisted state. Profiles live in `<dataDir>/profiles/<id>/userdata`. */
  dataDir: string
  /** Engine install directory. Defaults to the CAMOUFOX_INSTALL_DIR env var / user cache. */
  kernelDir?: string
  logger?: CoreLogger
}

export interface ProfilesApi {
  list(): Promise<Profile[]>
  get(id: string): Promise<Profile | undefined>
  create(input: ProfileCreate): Promise<Profile>
  update(id: string, patch: ProfileUpdate): Promise<Profile>
  remove(id: string): Promise<void>
  clone(id: string, name?: string): Promise<Profile>
  /** Absolute path of the profile's isolated browser data directory. */
  userDataDir(id: string): string
  /** Write a portable zip (config + userdata) of the profile to `destFile`. */
  exportZip(id: string, destFile: string): Promise<void>
  /** Create a new profile from a zip produced by {@link exportZip}. */
  importZip(zipFile: string, name?: string): Promise<Profile>
  /**
   * Create `count` profiles in one call, each with its own generated identity, named
   * `<namePrefix> <index>`. All or nothing: a failure leaves the store exactly as it was. The result
   * is in creation order.
   */
  createBatch(input: ProfileBatchCreate): Promise<Profile[]>
}

export interface GroupsApi {
  list(): Promise<Group[]>
  create(name: string): Promise<Group>
  rename(id: string, name: string): Promise<Group>
  remove(id: string): Promise<void>
}

export interface RuntimeApi {
  /**
   * One entry per profile in the store, `stopped` for anything never launched.
   *
   * Asynchronous because membership comes from the store, which reads `profiles.json` per call: a
   * profile created by another process must appear here without a restart. The registry itself is
   * per-process and cannot see what another instance launched, which is the whole point.
   */
  list(): Promise<ProfileRuntime[]>
  get(id: string): ProfileRuntime
  launch(id: string): Promise<ProfileRuntime>
  stop(id: string): Promise<ProfileRuntime>
  /** Subscribe to runtime transitions. Returns an unsubscribe function. */
  on(event: 'change', cb: (runtime: ProfileRuntime) => void): () => void
}

export interface KernelApi {
  info(): Promise<KernelInfo>
  install(): Promise<KernelInfo>
  /**
   * Subscribe to install progress. Returns an unsubscribe function.
   * Mirrors `RuntimeApi.on('change')`; the HTTP layer forwards these to the `kernel` SSE event.
   */
  on(event: 'progress', cb: (progress: KernelProgress) => void): () => void
}

export interface CookieImportOptions {
  /** `merge` (default) upserts by `(host, name, path)`; `replace` empties the jar first. */
  mode?: CookieImportMode
}

export interface CookieExport {
  /** Netscape `cookies.txt` content, ready to be written to a file. */
  content: string
  /** Cookies included in the file. */
  cookies: number
  /** Cookies the format cannot represent, with the reason. */
  skipped: CookieSkip[]
  /**
   * `false` when the profile has no cookie store yet (it has never been launched). The export is
   * still a valid, header-only file; callers should say so rather than report a bare "0 cookies".
   */
  hasCookieStore: boolean
}

export interface CookiesApi {
  /**
   * Render the profile's cookie jar as Netscape `cookies.txt`.
   *
   * The jar is read from disk, never through a browser launch, so exporting fifty profiles is fifty
   * SQLite reads rather than fifty browsers. **The profile must be stopped**: a live browser owns
   * the file and its in-memory jar would diverge from what is on disk. Throws when it is not.
   */
  export(id: string): Promise<CookieExport>
  /**
   * Merge or replace cookies from Netscape `cookies.txt` content.
   *
   * **The profile must be stopped**, for the same reason as {@link export}. `merge` (default)
   * upserts by `(host, name, path)` and leaves the rest of the jar alone; `replace` empties it
   * first. Throws when the profile is running, and when it has no cookie store yet — launch it once
   * so the engine creates `cookies.sqlite`, because VFox will not fabricate a Firefox database.
   */
  import(id: string, content: string, options?: CookieImportOptions): Promise<CookieImportResult>
}

export interface Core {
  readonly dataDir: string
  readonly profiles: ProfilesApi
  readonly groups: GroupsApi
  readonly runtime: RuntimeApi
  readonly kernel: KernelApi
  readonly cookies: CookiesApi
  close(): Promise<void>
}

export function createCore(options: CoreOptions): Promise<Core> {
  return createCoreImpl(options)
}
