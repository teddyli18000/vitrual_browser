/**
 * In-process lifecycle of the VFox core service.
 *
 * The desktop app does NOT spawn a sidecar: `@vfox/server` runs inside the Electron main
 * process, exactly like the CLI's `vfox serve`. One process, one profile store, one contract.
 *
 * If the service cannot start (port taken, corrupt store, missing build) the window is still
 * created and the renderer shows a clear banner instead of a white screen — see
 * `ServiceState.error`.
 */

import { createConnection } from 'node:net'
import type { ServerHandle } from '@vfox/server'
import {
  API_ROUTES,
  API_TOKEN_HEADER,
  type ApiResult,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  ENV,
  type ProfileRuntime,
} from '@vfox/shared'
import { createFileLogger, type Logger } from './log-file.js'

export interface ServiceState {
  /** true when the embedded HTTP API is listening. */
  ok: boolean
  /** Base URL the renderer must talk to, with no trailing slash. */
  url: string
  /** Token for the `x-vfox-token` header. Empty when the service is down. */
  token: string
  /** Human readable reason the service is unavailable, or null. */
  error: string | null
}

let handle: ServerHandle | null = null

let log: Logger = {
  debug: (msg: string, ...args: unknown[]) => console.debug(`[vfox] ${msg}`, ...args),
  info: (msg: string, ...args: unknown[]) => console.info(`[vfox] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[vfox] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[vfox] ${msg}`, ...args),
}

/**
 * Redirect the service logger into `<dataDir>/logs` once the data directory is known, so the
 * core's own logs travel with a portable folder instead of landing somewhere absolute.
 */
export function configureLogging(logDir: string): void {
  log = createFileLogger(logDir)
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function currentHandle(): ServerHandle | null {
  return handle
}

/** Start the embedded API. Never throws: a failure is reported through `ServiceState`. */
export async function startService(dataDir: string): Promise<ServiceState> {
  if (handle) return stateOf(handle)

  try {
    const { startServer } = await import('@vfox/server')
    const started = await startServer({ dataDir, logger: log })
    handle = started
    log.info(`API listening on ${started.url}`)
    return stateOf(started)
  } catch (err) {
    handle = null
    const error = describe(err)
    log.error(`failed to start the embedded API: ${error}`)
    return {
      ok: false,
      url: `http://${DEFAULT_API_HOST}:${process.env[ENV.apiPort] ?? DEFAULT_API_PORT}`,
      token: '',
      error,
    }
  }
}

function stateOf(started: ServerHandle): ServiceState {
  return { ok: true, url: started.url, token: started.token, error: null }
}

export async function stopService(): Promise<void> {
  const current = handle
  handle = null
  if (!current) return
  try {
    await current.close()
  } catch (err) {
    log.warn(`error while closing the API: ${describe(err)}`)
  }
}

/** Thin client for the loopback API, used by the tray and by app shutdown. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const current = handle
  if (!current) throw new Error('VFox service is not running')
  const res = await fetch(`${current.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      [API_TOKEN_HEADER]: current.token,
      ...(init?.headers ?? {}),
    },
  })
  const body = (await res.json()) as ApiResult<T>
  if (!body.success) throw new Error(body.error.message)
  return body.data
}

/**
 * Stop every profile that is not already stopped. Used by the tray's 全部停止 and by quit, so
 * no browser survives the app.
 */
export async function stopAllProfiles(): Promise<number> {
  if (!handle) return 0
  let runtimes: ProfileRuntime[]
  try {
    runtimes = await api<ProfileRuntime[]>(API_ROUTES.runtime)
  } catch (err) {
    log.warn(`cannot list runtime state: ${describe(err)}`)
    return 0
  }
  const active = runtimes.filter(rt => rt.status !== 'stopped' && rt.status !== 'error')
  await Promise.allSettled(
    active.map(rt => api<ProfileRuntime>(API_ROUTES.stopProfile(rt.profileId), { method: 'POST' })),
  )
  return active.length
}

export interface ProxyProbeResult {
  ok: boolean
  /** Round trip time in milliseconds, when the endpoint answered. */
  ms: number | null
  message: string
}

/**
 * Reachability probe for a proxy endpoint: a plain TCP connect from this machine to
 * `<host>:<port>`, with a short timeout.
 *
 * Deliberately NOT a request through the proxy to a third-party "echo" service: that would make
 * the product itself talk to a server the user never configured, which the zero-telemetry rule
 * forbids. This tells the user exactly what it can tell: whether the proxy endpoint answers.
 */
export function probeProxy(
  host: string,
  port: number,
  timeoutMs = 6000,
): Promise<ProxyProbeResult> {
  return new Promise(resolve => {
    const started = Date.now()
    let settled = false
    const socket = createConnection({ host, port })

    const finish = (result: ProxyProbeResult): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () =>
      finish({ ok: true, ms: Date.now() - started, message: 'TCP 连接成功' }),
    )
    socket.once('timeout', () =>
      finish({ ok: false, ms: null, message: `连接超时（${timeoutMs} ms）` }),
    )
    socket.once('error', (err: Error) => finish({ ok: false, ms: null, message: err.message }))
  })
}
