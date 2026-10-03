/**
 * Server-sent events — the *only* way runtime and kernel state reaches a client.
 *
 * Product rule (AGENTS.md): **no polling**. This hub subscribes once to `core.runtime.on('change')`
 * (and `core.kernel.on('progress')`) and fans every transition out to the connected clients; it
 * never reads core state on a timer. The one timer it owns is a comment-only keepalive (`: ping`)
 * that keeps an idle socket from being reaped by an intermediary — it carries no state and never
 * touches the core.
 *
 * Frames:
 *   retry: 3000            once, on connect
 *   event: runtime         data = ProfileRuntime
 *   event: kernel          data = KernelProgress
 */

import type { ServerResponse } from 'node:http'

import type { Core, CoreLogger } from '@vfox/core'
import type { KernelProgress, ProfileRuntime } from '@vfox/shared'
import { KernelProgressSchema, SSE_EVENT_KERNEL, SSE_EVENT_RUNTIME } from '@vfox/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { silentLogger } from './logger.js'

export interface EventHubOptions {
  core: Core
  logger?: CoreLogger
  /** Keepalive comment interval in ms. 0 disables it. */
  heartbeatMs?: number
}

const DEFAULT_HEARTBEAT_MS = 25_000
const RETRY_MS = 3_000

export class EventHub {
  readonly #core: Core
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
  #heartbeat: NodeJS.Timeout | undefined
  #lastKernel: KernelProgress | undefined
  #lastKernelFrame: string | undefined
  #started = false

  constructor(options: EventHubOptions) {
    this.#core = options.core
    this.#logger = options.logger ?? silentLogger
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.kernelProgressFromCore = typeof options.core.kernel.on === 'function'
  }

  /** Subscribes to core transitions. Called once, by `createApp`. */
  start(): void {
    if (this.#started) return
    this.#started = true

    this.#unsubscribeRuntime = this.#core.runtime.on('change', runtime => {
      this.#broadcast(SSE_EVENT_RUNTIME, runtime)
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

  #broadcast(event: string, payload: ProfileRuntime | KernelProgress): void {
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
