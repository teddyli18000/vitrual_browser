/**
 * A minimal client for the VFox HTTP API.
 *
 * `vfox sync` is the one command that cannot work in-process. The synchroniser session belongs to
 * the **server** — `startServer` constructs it once and the GUI watches it over SSE — so a session
 * opened inside a short-lived CLI process would end the moment the command exited. These commands
 * therefore drive a server that is already running (`vfox serve`, or the desktop app) over the same
 * loopback API the renderer talks to.
 *
 * Only the envelope is unwrapped here. Every path comes from `API_ROUTES` in `@vfox/shared`, so a
 * route change is a compile error instead of a 404 discovered at runtime.
 */

import { readFile } from 'node:fs/promises'

import type { ApiResult } from '@vfox/shared'
import {
  API_TOKEN_HEADER,
  ApiErrorSchema,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  ENV,
} from '@vfox/shared'

import { CliError } from './core.js'

export interface ApiClientOptions {
  /** `--url`. Defaults to `VFOX_API_HOST`/`VFOX_API_PORT`, i.e. `http://127.0.0.1:9000`. */
  url?: string
  /** `--token`. Defaults to `VFOX_API_TOKEN`, then `<dataDir>/api-token`. */
  token?: string
  /** The resolved data directory, used only to locate the persisted token. */
  dataDir: string
}

export interface ApiClient {
  readonly url: string
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
}

export async function openApi(options: ApiClientOptions): Promise<ApiClient> {
  const url = (options.url ?? defaultUrl()).replace(/\/+$/, '')
  const token = await clientToken(options)

  async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { [API_TOKEN_HEADER]: token }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new CliError(
        `Cannot reach the VFox API at ${url} (${message(error)}) — start it with \`vfox serve\`, ` +
          'or point --url at the port it reported.',
      )
    }

    const payload = await parseEnvelope<T>(response)
    if (!payload.success) throw new CliError(payload.error.message)
    return payload.data
  }

  return {
    url,
    get: path => send('GET', path),
    post: (path, body) => send('POST', path, body),
  }
}

/**
 * The token is **read**, never minted: only the server may create one, and a client that generated
 * its own would write a file that then fails every request.
 */
async function clientToken(options: ApiClientOptions): Promise<string> {
  if (options.token) return options.token

  const fromEnv = process.env[ENV.apiToken]
  if (fromEnv) return fromEnv

  const { apiTokenPath } = await import('@vfox/server')
  const file = apiTokenPath(options.dataDir)
  const raw = await readFile(file, 'utf8').catch(() => undefined)
  const token = raw?.trim()
  if (!token) {
    throw new CliError(
      `No API token at ${file} — start the server with \`vfox serve\` (it writes the token there), ` +
        'or pass --token.',
    )
  }
  return token
}

function defaultUrl(): string {
  const host = process.env[ENV.apiHost] ?? DEFAULT_API_HOST
  const port = process.env[ENV.apiPort] ?? String(DEFAULT_API_PORT)
  return `http://${host}:${port}`
}

/**
 * The API answers with the frozen `ApiResult` envelope. Anything else — a different service on the
 * port, an HTML error page — is reported as such rather than being mistaken for an empty success.
 */
async function parseEnvelope<T>(response: Response): Promise<ApiResult<T>> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new CliError(
      `The VFox API at ${response.url} answered ${response.status} with a body that is not JSON ` +
        '— is that really the VFox API?',
    )
  }

  const envelope = payload as { success?: unknown; data?: unknown; error?: unknown } | null
  if (envelope?.success === true) {
    return { success: true, data: envelope.data as T }
  }
  const error = ApiErrorSchema.safeParse(envelope?.error)
  if (envelope?.success === false && error.success) {
    return { success: false, error: error.data }
  }
  throw new CliError(
    `The VFox API at ${response.url} answered ${response.status} with a body that is not an ` +
      'ApiResult envelope',
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
