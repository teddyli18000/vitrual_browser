/**
 * The sync session: attach to the master, attach to every slave, mirror until stopped.
 *
 * State transitions are pushed to `on('change')` subscribers and are driven by real events —
 * attach, detach, a browser disconnecting — never by a polling loop. The one timer in this file
 * coalesces the diagnostic event counter so a UI can show it live without one SSE frame per
 * mouse move; it is armed by an event and disarms itself.
 */

import { randomUUID } from 'node:crypto'
import type { CoreLogger } from '@vfox/core'
import type { SyncSession, SyncStart, TileLayout, TileRequest } from '@vfox/shared'
import type { BrowserConnector } from './browser.js'
import { SyncError } from './errors.js'
import type { SyncHandle, SyncOptions, SyncTarget } from './index.js'
import { ViewportTracker } from './mapping.js'
import { MasterLink } from './master.js'
import { normalizeMirrorEvent } from './mirror.js'
import { SlaveMirror } from './slave.js'
import type { TileBackend } from './tile.js'
import { computeTileGrid } from './tile-grid.js'

/** How often the mirrored-event counter is pushed while events are flowing. */
const COUNT_EMIT_MS = 250

const NOOP_LOGGER: CoreLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

type ChangeListener = (session: SyncSession | null) => void

/** Everything `createSync` needs from the outside world; tests replace both. */
export interface SyncDeps {
  connect: BrowserConnector
  tile: TileBackend
  now?: () => number
  newId?: () => string
}

export function createSyncWith(options: SyncOptions, deps: SyncDeps): SyncHandle {
  return new SyncEngine(options, deps)
}

class SyncEngine implements SyncHandle {
  readonly #options: SyncOptions
  readonly #deps: SyncDeps
  readonly #logger: CoreLogger
  readonly #viewports: ViewportTracker
  readonly #listeners = new Set<ChangeListener>()

  #session: SyncSession | null = null
  #master: MasterLink | null = null
  #slaves: SlaveMirror[] = []
  #countTimer: ReturnType<typeof setTimeout> | null = null
  #stopping: Promise<void> | null = null
  #closed = false

  constructor(options: SyncOptions, deps: SyncDeps) {
    this.#options = options
    this.#deps = deps
    this.#logger = options.logger ?? NOOP_LOGGER
    this.#viewports = new ViewportTracker(deps.now ?? Date.now)
  }

  async start(input: SyncStart): Promise<SyncSession> {
    if (this.#closed) {
      throw new SyncError('the window synchroniser is closed', 'closed')
    }
    if (this.#session) {
      throw new SyncError('a sync session is already active — call stop() first', 'already_active')
    }
    const masterProfileId = typeof input?.masterProfileId === 'string' ? input.masterProfileId : ''
    if (!masterProfileId) {
      throw new SyncError('start() requires a master profile id', 'invalid_input')
    }
    const slaveProfileIds = uniqueIds(input?.slaveProfileIds)
    if (slaveProfileIds.length === 0) {
      throw new SyncError('start() requires at least one slave profile', 'invalid_input')
    }
    if (slaveProfileIds.includes(masterProfileId)) {
      throw new SyncError(
        `profile "${masterProfileId}" cannot be both the master and a slave`,
        'invalid_input',
      )
    }

    const masterTarget = this.#runningTarget(masterProfileId)
    const slaveTargets = slaveProfileIds.map(profileId => ({
      profileId,
      target: this.#runningTarget(profileId),
    }))
    for (const slave of slaveTargets) {
      if (sameBrowser(slave.target, masterTarget)) {
        // The same browser on both ends would replay our own input back into the master.
        throw new SyncError(
          `slave "${slave.profileId}" resolves to the same browser as the master`,
          'invalid_input',
        )
      }
    }

    const session: SyncSession = {
      id: (this.#deps.newId ?? randomUUID)(),
      masterProfileId,
      slaveProfileIds: [...slaveProfileIds],
      active: true,
      startedAt: new Date(this.#now()).toISOString(),
      mirroredEvents: 0,
    }
    // Set before attaching so events that arrive during the attach are counted, not lost.
    this.#session = session

    try {
      this.#master = await MasterLink.attach({
        profileId: masterProfileId,
        label: masterTarget.name ?? masterProfileId,
        wsEndpoint: masterTarget.wsEndpoint,
        connect: this.#deps.connect,
        logger: this.#logger,
        onEvent: payload => this.#onMasterEvent(masterProfileId, payload),
        onGone: () => this.#onMasterGone(masterProfileId),
      })
      for (const slave of slaveTargets) {
        this.#slaves.push(
          await SlaveMirror.attach({
            profileId: slave.profileId,
            label: slave.target.name ?? slave.profileId,
            wsEndpoint: slave.target.wsEndpoint,
            connect: this.#deps.connect,
            logger: this.#logger,
            viewports: this.#viewports,
            onGone: profileId => this.#onSlaveGone(profileId),
          }),
        )
      }
    } catch (error) {
      // A half-attached session must not leave listeners behind.
      await this.#releaseAll()
      throw error
    }

    this.#emit()
    return cloneSession(session)
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      return this.#stopping
    }
    const running = this.#session !== null
    const stopping = (async () => {
      await this.#releaseAll()
      if (running) {
        this.#emit()
      }
    })()
    this.#stopping = stopping
    try {
      await stopping
    } finally {
      this.#stopping = null
    }
  }

  current(): SyncSession | null {
    return this.#session ? cloneSession(this.#session) : null
  }

  async tile(request: TileRequest): Promise<void> {
    const profileIds = uniqueIds(request?.profileIds)
    if (profileIds.length === 0) {
      throw new SyncError('tile() requires at least one profile id', 'invalid_input')
    }
    const entries = profileIds.map(profileId => ({ profileId, pid: this.#windowPid(profileId) }))
    const displayIndex = request.displayIndex ?? null
    const workArea = await this.#deps.tile.workArea(displayIndex)
    const rects = computeTileGrid(entries.length, layoutOf(request), workArea)

    let moved = 0
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const rect = rects[index]
      if (!entry || !rect) {
        continue
      }
      moved += await this.#deps.tile.place(entry.pid, rect)
    }
    if (moved === 0) {
      throw new SyncError(
        'no visible browser window matched the given profiles — are their windows open?',
        'tiling_unavailable',
      )
    }
    const first = entries[0]
    if (first) {
      await this.#deps.tile.focus(first.pid)
    }
  }

  on(_event: 'change', callback: ChangeListener): () => void {
    this.#listeners.add(callback)
    return () => {
      this.#listeners.delete(callback)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    await this.stop()
    this.#closed = true
    this.#listeners.clear()
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now()
  }

  #runningTarget(profileId: string): SyncTarget & { wsEndpoint: string } {
    const target = this.#options.resolve(profileId)
    if (!target) {
      throw new SyncError(`unknown profile "${profileId}"`, 'unknown_profile')
    }
    const wsEndpoint = target.wsEndpoint
    if (!wsEndpoint) {
      throw new SyncError(
        `profile "${target.name ?? profileId}" is not running — start its window before syncing`,
        'not_running',
      )
    }
    return { ...target, wsEndpoint }
  }

  #windowPid(profileId: string): number {
    const target = this.#options.resolve(profileId)
    if (!target) {
      throw new SyncError(`unknown profile "${profileId}"`, 'unknown_profile')
    }
    if (target.pid === null) {
      throw new SyncError(
        `profile "${target.name ?? profileId}" is not running — there is no window to tile`,
        'not_running',
      )
    }
    return target.pid
  }

  #onMasterEvent(profileId: string, payload: unknown): void {
    const session = this.#session
    // Feedback-loop guard: only the profile that owns the active master link may be a source.
    if (!session || session.masterProfileId !== profileId) {
      return
    }
    const event = normalizeMirrorEvent(payload)
    if (!event) {
      return
    }
    session.mirroredEvents += 1
    for (const slave of this.#slaves) {
      slave.enqueue(event)
    }
    this.#scheduleCount()
  }

  #onMasterGone(profileId: string): void {
    if (this.#session?.masterProfileId !== profileId) {
      return
    }
    this.#logger.warn(`sync: master "${profileId}" disconnected — stopping the session`)
    void this.stop()
  }

  #onSlaveGone(profileId: string): void {
    const session = this.#session
    if (!session || !session.slaveProfileIds.includes(profileId)) {
      return
    }
    this.#slaves = this.#slaves.filter(slave => slave.profileId !== profileId)
    session.slaveProfileIds = session.slaveProfileIds.filter(id => id !== profileId)
    this.#logger.warn(`sync: slave "${profileId}" disconnected`)
    if (session.slaveProfileIds.length === 0) {
      // Nothing left to mirror into; the master should not stay instrumented for nothing.
      void this.stop()
      return
    }
    this.#emit()
  }

  #scheduleCount(): void {
    if (this.#countTimer) {
      return
    }
    this.#countTimer = setTimeout(() => {
      this.#countTimer = null
      if (this.#session) {
        this.#emit()
      }
    }, COUNT_EMIT_MS)
    // A UI counter must never keep the process alive.
    this.#countTimer.unref()
  }

  async #releaseAll(): Promise<void> {
    this.#session = null
    if (this.#countTimer) {
      clearTimeout(this.#countTimer)
      this.#countTimer = null
    }
    const slaves = this.#slaves
    const master = this.#master
    this.#slaves = []
    this.#master = null

    for (const slave of slaves) {
      try {
        await slave.stop()
      } catch (error) {
        this.#logger.warn(`sync: detaching slave "${slave.profileId}" failed: ${message(error)}`)
      }
    }
    if (master) {
      try {
        await master.detach()
      } catch (error) {
        this.#logger.warn(`sync: detaching master "${master.profileId}" failed: ${message(error)}`)
      }
    }
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.current())
      } catch (error) {
        this.#logger.warn(`sync: a change listener failed: ${message(error)}`)
      }
    }
  }
}

function layoutOf(request: TileRequest): TileLayout {
  return request.layout ?? 'grid'
}

function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return []
  }
  const unique: string[] = []
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && !unique.includes(id)) {
      unique.push(id)
    }
  }
  return unique
}

function sameBrowser(a: SyncTarget, b: SyncTarget): boolean {
  if (a.wsEndpoint && b.wsEndpoint && a.wsEndpoint === b.wsEndpoint) {
    return true
  }
  return a.pid !== null && b.pid !== null && a.pid === b.pid
}

function cloneSession(session: SyncSession): SyncSession {
  return { ...session, slaveProfileIds: [...session.slaveProfileIds] }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
