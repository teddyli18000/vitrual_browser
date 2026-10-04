/**
 * Server-sent events — the *only* way runtime, kernel and synchroniser state reaches a client.
 *
 * Product rule (AGENTS.md): **no polling**. This hub subscribes once to `core.runtime.on('change')`,
 * `core.kernel.on('progress')` and `sync.on('change')` and fans every transition out to the
 * connected clients; it never reads that state on a timer. The one timer it owns is a comment-only
 * keepalive (`: ping`) that keeps an idle socket from being reaped by an intermediary — it carries
 * no state and never touches the core.
 *
 * Frames:
 *   retry: 3000            once, on connect
 *   event: runtime         data = ProfileRuntime
 *   event: kernel          data = KernelProgress
 *   event: sync            data = SyncSession | null
 */

import type { ServerResponse } from 'node:http'

import type { Core, CoreLogger } from '@vfox/core'
import type { KernelProgress, ProfileRuntime, SyncSession } from '@vfox/shared'
import {
  KernelProgressSchema,
  SSE_EVENT_KERNEL,
  SSE_EVENT_RUNTIME,
  SSE_EVENT_SYNC,
  SyncSessionSchema,
} from '@vfox/shared'
import type { SyncHandle } from '@vfox/sync'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { silentLogger } from './logger.js'

export interface EventHubOptions {
  core: Core
  sync: SyncHandle
  logger?: CoreLogger
  /** Keepalive comment interval in ms. 0 disables it. */
  heartbeatMs?: number
}

const DEFAULT_HEARTBEAT_MS = 25_000
const RETRY_MS = 3_000

export class EventHub {
  readonly #core: Core
  readonly #sync: SyncHandle
  readonly #logger: CoreLogger
  readonly #heartbeatMs: number
  readonly #clients = new Set<ServerResponse>()
  /**
   * `true` when the core can report install progress itself. When it cannot, the kernel route
   * publishes coarse phase transitions instead — see `routes/kernel.ts`.
   */
  readonly kernelProgressFromCore: boolean
  #unsubscribeRuntime: (() => void) | undefined
  #unsubscribeKernel: (() => void) | undefined
  #unsubscribeSync: (() => void) | undefined
  #heartbeat: NodeJS.Timeout | undefined
  #lastKernel: KernelProgress | undefined
  #lastKernelFrame: string | undefined
  /** `undefined` = nothing published yet; `null` = the session was stopped. */
  #lastSync: SyncSession | null | undefined
  #lastSyncFrame: string | undefined
  #started = false

  constructor(options: EventHubOptions) {
    this.#core = options.core
    this.#sync = options.sync
    this.#logger = options.logger ?? silentLogger
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.kernelProgressFromCore = typeof options.core.kernel.on === 'function'
  }

  /** Subscribes to core and synchroniser transitions. Called once, by `createApp`. */
  start(): void {
    if (this.#started) return
    this.#started = true

    this.#unsubscribeRuntime = this.#core.runtime.on('change', runtime => {
      this.#broadcast(SSE_EVENT_RUNTIME, runtime)
    })

    this.#unsubscribeSync = this.#sync.on('change', session => {
      this.publishSync(session)
    })

    if (this.kernelProgressFromCore) {
      this.#unsubscribeKernel = this.#core.kernel.on('progress', progress => {
        this.publishKernel(progress)
      })
    } else {
      this.#logger.warn('core.kernel.on("progress") is unavailable; using coarse kernel phases')
    }
  }

  /** Unsubscribes and closes every open stream. */
  stop(): void {
    this.#started = false
    this.#unsubscribeRuntime?.()
    this.#unsubscribeRuntime = undefined
    this.#unsubscribeKernel?.()
    this.#unsubscribeKernel = undefined
    this.#unsubscribeSync?.()
    this.#unsubscribeSync = undefined
    this.#stopHeartbeat()
    for (const res of [...this.#clients]) {
      this.#clients.delete(res)
      this.#end(res)
    }
  }

  /** Pushes a kernel install progress frame to every connected client. */
  publishKernel(progress: KernelProgress): void {
    const parsed = KernelProgressSchema.safeParse(progress)
    if (!parsed.success) {
      this.#logger.warn('dropping malformed kernel progress frame', parsed.error.issues)
      return
    }
    const frame = parsed.data
    const json = JSON.stringify(frame)
    // Core-reported progress and the route's coarse fallback can describe the same transition.
    if (json === this.#lastKernelFrame) return
    this.#lastKernelFrame = json
    this.#lastKernel = frame
    this.#broadcast(SSE_EVENT_KERNEL, frame)
  }

  get clientCount(): number {
    return this.#clients.size
  }

  /**
   * Pushes a synchroniser session transition to every connected client. `null` means "no session
   * is active" and is a real transition — it is what a UI clears its state on.
   */
  publishSync(session: SyncSession | null): void {
    let frame: SyncSession | null = null
    if (session !== null) {
      const parsed = SyncSessionSchema.safeParse(session)
      if (!parsed.success) {
        this.#logger.warn('dropping malformed sync session frame', parsed.error.issues)
        return
      }
      frame = parsed.data
    }
    const json = JSON.stringify(frame)
    // The route's answer and a session event can describe the same transition.
    if (json === this.#lastSyncFrame) return
    this.#lastSyncFrame = json
    this.#lastSync = frame
    this.#broadcast(SSE_EVENT_SYNC, frame)
  }

  /**
   * Turns a Fastify request into an event stream. The reply is hijacked: from here on the raw
   * `ServerResponse` owns the socket and Fastify must not touch it.
   */
  handle(request: FastifyRequest, reply: FastifyReply): void {
    reply.hijack()
    const res = reply.raw
    const req = request.raw

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: ${RETRY_MS}\n\n`)

    this.#clients.add(res)
    this.#startHeartbeat()

    // Snapshot on connect, so a late client is immediately consistent without polling anything.
    for (const runtime of this.#core.runtime.list()) {
      this.#write(res, SSE_EVENT_RUNTIME, runtime)
    }
    if (this.#lastKernel && this.#lastKernel.phase !== 'idle') {
      this.#write(res, SSE_EVENT_KERNEL, this.#lastKernel)
    }
    // Only a *running* session is replayed: a client that has never seen one starts out knowing
    // there is none, and `GET /sync` answers the current state for anything older.
    if (this.#lastSync) {
      this.#write(res, SSE_EVENT_SYNC, this.#lastSync)
    }

    const cleanup = (): void => {
      if (!this.#clients.delete(res)) return
      if (this.#clients.size === 0) this.#stopHeartbeat()
      this.#end(res)
    }

    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
    this.#logger.debug('sse client connected', { clients: this.#clients.size })
  }

  #broadcast(event: string, payload: ProfileRuntime | KernelProgress | SyncSession | null): void {
    if (this.#clients.size === 0) return
    for (const res of [...this.#clients]) {
      if (this.#write(res, event, payload)) continue
      this.#clients.delete(res)
      if (this.#clients.size === 0) this.#stopHeartbeat()
    }
  }

  #write(res: ServerResponse, event: string, payload: unknown): boolean {
    return this.#raw(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  /** SSE comment frame: invisible to `EventSource`, carries no state. */
  #comment(res: ServerResponse, text: string): boolean {
    return this.#raw(res, `: ${text}\n\n`)
  }

  #raw(res: ServerResponse, chunk: string): boolean {
    try {
      if (res.writableEnded || res.destroyed) return false
      res.write(chunk)
      return true
    } catch {
      return false
    }
  }

  #end(res: ServerResponse): void {
    try {
      if (!res.writableEnded) res.end()
    } catch {
      // Already torn down by the peer.
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat || this.#heartbeatMs <= 0) return
    this.#heartbeat = setInterval(() => {
      for (const res of [...this.#clients]) this.#comment(res, 'ping')
    }, this.#heartbeatMs)
    // A keepalive must never be the reason a process stays alive.
    this.#heartbeat.unref?.()
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return
    clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
  }
}
