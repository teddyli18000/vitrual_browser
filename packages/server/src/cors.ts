/**
 * Loopback browser security: CORS for the Electron renderer plus a `Host` allowlist.
 *
 * Why this exists — the renderer is a browser context. In production it loads from `file://`
 * (an opaque origin, sent as `Origin: null`) and in development from the Vite dev server on another
 * port, so *every* call to `http://127.0.0.1:<port>` is cross-origin. `x-vfox-token` is not a
 * CORS-safelisted header, so Chromium sends a preflight `OPTIONS` first — and a preflight never
 * carries the custom header. Without the handling below the token check rejects the preflight with
 * 401 and the real request is never issued: a healthy server that the GUI reports as "not
 * connected".
 *
 * The origin allowlist is deliberate and narrow. `*` would let any page in the user's browser read
 * responses; reflecting only `null` and loopback origins keeps the token meaningful. CORS is not a
 * substitute for authentication — the token is — and it is not a DNS-rebinding defence either, so
 * the `Host` header is validated separately below.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'

import { HttpError } from './errors.js'
import { isWriteMethod } from './guards.js'

export const CORS_ALLOW_HEADERS = 'content-type, x-vfox-token, authorization'
export const CORS_ALLOW_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS'
export const CORS_MAX_AGE_SECONDS = '600'

/** Hostnames that mean "this machine". Anything else is a rebinding attempt or a mistake. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/** `file://` renderers send the literal string `null`; dev servers are loopback with any port. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i

export function parseHostHeader(
  header: string | undefined,
): { name: string; port?: string } | undefined {
  if (typeof header !== 'string') return undefined
  const value = header.trim()
  if (value.length === 0) return undefined

  if (value.startsWith('[')) {
    // Bracketed IPv6, e.g. `[::1]:9000`.
    const end = value.indexOf(']')
    if (end === -1) return undefined
    const rest = value.slice(end + 1)
    return {
      name: value.slice(1, end).toLowerCase(),
      ...(rest.startsWith(':') ? { port: rest.slice(1) } : {}),
    }
  }

  const colon = value.lastIndexOf(':')
  if (colon === -1) return { name: value.toLowerCase() }
  return { name: value.slice(0, colon).toLowerCase(), port: value.slice(colon + 1) }
}

/**
 * The `Host` header must name this machine. When the socket knows its own port, the header's port
 * has to agree too — a forged port is a reliable sign of a hand-crafted request. `inject()`-style
 * transports have no socket port, so the port half of the check is skipped there.
 */
export function isAllowedHost(request: FastifyRequest): boolean {
  const parsed = parseHostHeader(request.headers.host)
  if (!parsed || !LOOPBACK_HOSTNAMES.has(parsed.name)) return false

  const localPort = request.raw.socket?.localPort
  if (typeof localPort === 'number' && parsed.port !== undefined) {
    return Number.parseInt(parsed.port, 10) === localPort
  }
  return true
}

/** The origin to reflect, or `undefined` when the request carries no allowed origin. */
export function allowedOrigin(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return undefined
  const value = origin.trim()
  if (value === 'null') return 'null'
  return LOOPBACK_ORIGIN.test(value) ? value : undefined
}

export function corsHeaders(request: FastifyRequest): Record<string, string> {
  const origin = allowedOrigin(request)
  return origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'Origin' }
}

export function applyCors(reply: FastifyReply, request: FastifyRequest): void {
  for (const [name, value] of Object.entries(corsHeaders(request))) reply.header(name, value)
}

/** Preflight response. Answered before the token check: a browser never sends the token here. */
export function answerPreflight(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  applyCors(reply, request)
  reply
    .header('access-control-allow-headers', CORS_ALLOW_HEADERS)
    .header('access-control-allow-methods', CORS_ALLOW_METHODS)
    .header('access-control-max-age', CORS_MAX_AGE_SECONDS)
  return reply.code(204).send()
}

/**
 * Refuses a **state-changing** request that carries a disallowed `Origin`.
 *
 * Omitting the CORS headers is enough to stop a browser *reading* a response, but the mutation has
 * already happened by then. For reads that is the right trade (rejecting them would only add noise);
 * for writes the server should refuse outright rather than rely on the browser to discard the
 * answer. So: `POST`/`PATCH`/`PUT`/`DELETE` with an `Origin` that is neither `null` nor loopback is
 * rejected with 403.
 *
 * A request with no `Origin` at all is untouched — curl, the CLI, MCP clients and existing
 * VirtualBrowser scripts send none, and `Origin` is not a security control for a non-browser
 * caller anyway (the token is).
 */
export function assertOriginAllowed(request: FastifyRequest): void {
  if (!isWriteMethod(request.method)) return

  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.trim().length === 0) return
  if (allowedOrigin(request) !== undefined) return

  throw new HttpError(
    403,
    'forbidden_origin',
    `Refusing ${request.method} from origin "${origin.trim()}" — the VFox API accepts the desktop renderer only (null or loopback origins)`,
  )
}
