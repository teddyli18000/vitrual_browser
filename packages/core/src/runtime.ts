/**
 * Runtime registry: the single source of truth for what is running.
 *
 * Every transition is pushed to `on('change')` subscribers (the HTTP layer forwards them to the
 * `kernel`/`runtime` SSE streams) and every transition is driven by a real event — the launch
 * promise or the browser's own exit event. There is deliberately no polling timer anywhere.
 */

import type { Profile, ProfileRuntime, RuntimeStatus } from '@vfox/shared'
import type { CoreLogger } from './index.js'
import type { BrowserExit, BrowserHandle, BrowserLauncher } from './launcher.js'

export interface RuntimeRegistryOptions {
  launch: BrowserLauncher
  /** Resolve a profile for launching; `undefined` means the id is unknown. */
  resolveProfile: (id: string) => Promise<Profile | undefined>
  userDataDir: (id: string) => string
  profileIds: () => string[]
  logger: CoreLogger
}

interface Entry {
  runtime: ProfileRuntime
  handle: BrowserHandle | null
  /** Resolves once an in-flight launch has settled; `null` when nothing is launching. */
  starting: Promise<void> | null
  /** A stop was requested while a launch was still in flight. */
  closing: boolean
}

type ChangeListener = (runtime: ProfileRuntime) => void

export class RuntimeRegistry {
  readonly #options: RuntimeRegistryOptions
  readonly #entries = new Map<string, Entry>()
  readonly #listeners = new Set<ChangeListener>()

  constructor(options: RuntimeRegistryOptions) {
    this.#options = options
  }

  list(): ProfileRuntime[] {
    return this.#options.profileIds().map(id => this.get(id))
  }

  get(id: string): ProfileRuntime {
    const entry = this.#entries.get(id)
    return entry ? clone(entry.runtime) : stopped(id)
  }

  async launch(id: string): Promise<ProfileRuntime> {
    const existing = this.#entries.get(id)
    if (
      existing &&
      (existing.runtime.status === 'starting' || existing.runtime.status === 'running')
    ) {
      return clone(existing.runtime)
    }

    // The entry exists before the profile lookup so that a `stop()` arriving in between is
    // remembered instead of being lost against a profile that is about to start.
    const entry = this.#set(id, {
      status: 'starting',
      pid: null,
      wsEndpoint: null,
      startedAt: null,
      lastError: null,
    })
    let releaseStarting = () => {}
    entry.starting = new Promise<void>(resolve => {
      releaseStarting = resolve
    })

    try {
      const profile = await this.#options.resolveProfile(id)
      if (!profile) {
        throw new Error(`Unknown profile: ${id}`)
      }

      const handle = await this.#options.launch({
        profile,
        userDataDir: this.#options.userDataDir(id),
        warn: message => this.#options.logger.warn(message),
        debug: message => this.#options.logger.debug(message),
      })

      if (entry.closing) {
        // stop() arrived while the engine was still starting up.
        await handle.close()
        this.#set(id, { status: 'stopped', pid: null, wsEndpoint: null, startedAt: null })
        return this.get(id)
      }

      entry.handle = handle
      handle.onExit(exit => this.#onExit(id, exit))
      this.#set(id, {
        status: 'running',
        pid: handle.pid,
        wsEndpoint: handle.wsEndpoint,
        startedAt: new Date().toISOString(),
        lastError: null,
      })
      return this.get(id)
    } catch (error) {
      this.#set(id, {
        status: entry.closing ? 'stopped' : 'error',
        pid: null,
        wsEndpoint: null,
        startedAt: null,
        lastError: errorMessage(error),
      })
      throw error
    } finally {
      entry.starting = null
      entry.closing = false
      releaseStarting()
    }
  }

  async stop(id: string): Promise<ProfileRuntime> {
    const entry = this.#entries.get(id)
    if (!entry || entry.runtime.status === 'stopped' || entry.runtime.status === 'error') {
      this.#set(id, { status: 'stopped', pid: null, wsEndpoint: null, startedAt: null })
      return this.get(id)
    }

    entry.closing = true
    this.#set(id, { status: 'stopping' })

    if (entry.starting) {
      // Wait for the launch to settle: it closes the handle it produced and reports `stopped`.
      await entry.starting
      return this.get(id)
    }

    const handle = entry.handle
    entry.handle = null
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        this.#options.logger.warn(`profile ${id}: stop failed: ${errorMessage(error)}`)
      }
    }

    this.#set(id, { status: 'stopped', pid: null, wsEndpoint: null, startedAt: null })
    entry.closing = false
    return this.get(id)
  }

  on(_event: 'change', listener: ChangeListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Stop everything that is still running. Used by `Core.close()`. */
  async closeAll(): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      try {
        await this.stop(id)
      } catch (error) {
        this.#options.logger.warn(`profile ${id}: shutdown failed: ${errorMessage(error)}`)
      }
    }
  }

  /** Drop the state of a profile that no longer exists. */
  forget(id: string): void {
    this.#entries.delete(id)
  }

  #onExit(id: string, exit: BrowserExit): void {
    const entry = this.#entries.get(id)
    if (!entry || entry.closing) {
      return
    }
    entry.handle = null
    const clean = exit.exitCode === 0
    this.#set(id, {
      status: clean ? 'stopped' : 'error',
      pid: null,
      wsEndpoint: null,
      startedAt: null,
      lastError: clean
        ? null
        : `browser exited unexpectedly (code ${exit.exitCode}, signal ${exit.signal})`,
    })
  }

  #set(id: string, patch: Partial<ProfileRuntime> & { status: RuntimeStatus }): Entry {
    const previous = this.#entries.get(id)
    const runtime: ProfileRuntime = {
      ...(previous?.runtime ?? stopped(id)),
      ...patch,
      profileId: id,
    }
    const entry: Entry = previous ?? { runtime, handle: null, starting: null, closing: false }
    entry.runtime = runtime
    this.#entries.set(id, entry)
    this.#emit(runtime)
    return entry
  }

  #emit(runtime: ProfileRuntime): void {
    const snapshot = clone(runtime)
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.#options.logger.warn(`runtime listener failed: ${errorMessage(error)}`)
      }
    }
  }
}

function stopped(id: string): ProfileRuntime {
  return {
    profileId: id,
    status: 'stopped',
    pid: null,
    wsEndpoint: null,
    startedAt: null,
    lastError: null,
  }
}

function clone(runtime: ProfileRuntime): ProfileRuntime {
  return { ...runtime }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
