/**
 * The renderer's only way to talk to the product: plain HTTP + SSE against the loopback API,
 * authenticated with the `x-vfox-token` header. Nothing here knows about Electron.
 */

import { API_TOKEN_HEADER, type ApiResult } from '@vfox/shared'

let apiBase = ''
let apiToken = ''

export function setConnection(base: string, token: string): void {
  apiBase = base.replace(/\/+$/, '')
  apiToken = token
}

export function connectionBase(): string {
  return apiBase
}

export function connectionToken(): string {
  return apiToken
}

export class ApiError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

function headers(extra?: HeadersInit): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    [API_TOKEN_HEADER]: apiToken,
    ...((extra as Record<string, string> | undefined) ?? {}),
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  if (!apiBase) throw new ApiError('no-service', '核心服务未启动')
  try {
    return await fetch(`${apiBase}${path}`, { ...init, headers: headers(init?.headers) })
  } catch (err) {
    throw new ApiError('network', err instanceof Error ? err.message : String(err))
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (text.length === 0) {
    if (res.ok) return undefined as T
    throw new ApiError(`http-${res.status}`, `HTTP ${res.status}`)
  }
  let body: ApiResult<T>
  try {
    body = JSON.parse(text) as ApiResult<T>
  } catch {
    throw new ApiError('bad-response', `HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!body.success) throw new ApiError(body.error.code, body.error.message, body.error.details)
  return body.data
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await send(path, { method: 'GET' }))
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  return unwrap<T>(
    await send(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  )
}

/** For endpoints that answer with raw bytes (profile export) or accept them (profile import). */
export async function apiBytes(path: string, init?: RequestInit): Promise<ArrayBuffer> {
  const res = await send(path, { ...init, headers: { accept: '*/*', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(`http-${res.status}`, text.slice(0, 200) || `HTTP ${res.status}`)
  }
  return res.arrayBuffer()
}

/** A raw `text/plain` response: the body, plus the filename the server chose for it. */
export interface TextDownload {
  text: string
  /** Decoded `Content-Disposition` filename, or null when the response carried none. */
  filename: string | null
}

/**
 * For endpoints that answer with raw text instead of the `ApiResult` envelope (cookie export).
 * Wrapping the body in a JSON shape here would invent a contract the server does not have, so the
 * text is returned as-is and the filename is read back out of `Content-Disposition` — the server
 * already sanitises it, and guessing it from the profile name in the UI would drift.
 */
export async function apiText(path: string): Promise<TextDownload> {
  const res = await send(path, { headers: { accept: 'text/plain' } })
  const body = await res.text()
  if (!res.ok) throw failureFrom(res, body)
  return { text: body, filename: filenameOf(res.headers.get('content-disposition')) }
}

/** Prefers the server's own envelope, so a raw-response failure keeps its `code` and message. */
function failureFrom(res: Response, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as ApiResult<unknown>
    if (!parsed.success) {
      return new ApiError(parsed.error.code, parsed.error.message, parsed.error.details)
    }
  } catch {
    // Not an envelope — an empty body, or something a proxy wrote. Fall through.
  }
  return new ApiError(`http-${res.status}`, body.slice(0, 200) || `HTTP ${res.status}`)
}

/** `filename*=UTF-8''…` (RFC 5987) is the real name; `filename="…"` is the ASCII fallback. */
function filenameOf(header: string | null): string | null {
  if (!header) return null
  const extended = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended)
    } catch {
      return extended
    }
  }
  return header.match(/filename="([^"]*)"/i)?.[1] ?? null
}

/** POST raw bytes (profile import) and unwrap the JSON envelope that comes back. */
export async function apiSendBytes<T>(path: string, bytes: ArrayBuffer): Promise<T> {
  return unwrap<T>(
    await send(path, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'application/zip' },
    }),
  )
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
