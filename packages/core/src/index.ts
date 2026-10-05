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
  ProfileAddon,
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
  /**
   * The primary display's work area, when the caller can see it — the desktop main process can, the
   * CLI and the server cannot. New profiles are sized to a comfortable fraction of it and pinned
   * there, so a profile window always fits the screen it will open on. When it is absent, the sizing
   * falls back to the display the fingerprint itself claims, which is what every caller did before
   * this field existed.
   */
  workArea?: { width: number; height: number }
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

export interface AddonInstallOptions {
  /** Replace an addon already installed under the same slug instead of refusing. */
  replace?: boolean
}

export interface AddonsApi {
  /**
   * The addons this profile will load: the ones VFox manages, plus the engine's own defaults
   * (`source: 'engine'`, read-only in v1).
   *
   * **Readable while the profile runs.** Unlike the cookie jar this store is an inert directory on
   * disk that no browser holds open, so what is on disk *is* the truth and refusing would only stop
   * the UI from showing what a running profile carries.
   */
  list(id: string): Promise<ProfileAddon[]>
  /**
   * Install an addon from a local path: an extracted addon directory, or an `.xpi`/`.zip` that VFox
   * extracts for you — the engine only loads directories.
   *
   * **The profile must be stopped.** The addon list is baked into the engine's launch environment,
   * so an install while it runs would silently do nothing until the next launch, and a remove could
   * delete a directory the browser has loaded. Throws when it is running, and when something is
   * already installed under the same slug unless `replace` is set.
   */
  install(id: string, sourcePath: string, options?: AddonInstallOptions): Promise<ProfileAddon>
  /**
   * Remove one addon by slug or gecko id.
   *
   * **The profile must be stopped**, for the same reason as {@link install}. Throws for the engine's
   * own defaults: they are loaded because the engine's launcher adds them, and excluding one needs
   * per-profile state that does not exist yet.
   */
  remove(id: string, slugOrId: string): Promise<ProfileAddon>
}

export interface Core {
  readonly dataDir: string
  readonly profiles: ProfilesApi
  readonly groups: GroupsApi
  readonly runtime: RuntimeApi
  readonly kernel: KernelApi
  readonly cookies: CookiesApi
  readonly addons: AddonsApi
  close(): Promise<void>
}

export function createCore(options: CoreOptions): Promise<Core> {
  return createCoreImpl(options)
}
