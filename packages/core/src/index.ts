/**
 * Frozen public surface of @vfox/core.
 *
 * This file is the contract every other package codes against (server, cli, desktop).
 * The implementation lives in ./core.ts; keep the exported signatures below stable.
 */

import type {
  Group,
  KernelInfo,
  KernelProgress,
  Profile,
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
}

export interface GroupsApi {
  list(): Promise<Group[]>
  create(name: string): Promise<Group>
  rename(id: string, name: string): Promise<Group>
  remove(id: string): Promise<void>
}

export interface RuntimeApi {
  list(): ProfileRuntime[]
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

export interface Core {
  readonly dataDir: string
  readonly profiles: ProfilesApi
  readonly groups: GroupsApi
  readonly runtime: RuntimeApi
  readonly kernel: KernelApi
  close(): Promise<void>
}

export function createCore(options: CoreOptions): Promise<Core> {
  return createCoreImpl(options)
}
