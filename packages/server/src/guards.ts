/**
 * Request guards that a handler must not be trusted to remember.
 *
 * The content-type rule exists for CSRF. A cross-site HTML form can only produce the three
 * CORS-safelisted content types, so requiring `application/json` on any write that carries a body
 * makes that class of attack fail before a handler runs. `application/zip` is not safelisted
 * either, which is why the one binary route keeps working under the same rule.
 */

import { API_ROUTES } from '@vfox/shared'
import type { FastifyRequest } from 'fastify'

import { HttpError } from './errors.js'

/** Content types accepted by `POST /profiles/import`. Neither is CORS-safelisted. */
export const ZIP_CONTENT_TYPES = ['application/zip', 'application/x-zip-compressed'] as const

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase())
}

/** `true` when the request actually carries a body, whatever the method. */
export function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length']
  if (typeof length === 'string' && Number.parseInt(length, 10) > 0) return true
  return typeof request.headers['transfer-encoding'] === 'string'
}

export function contentTypeOf(request: FastifyRequest): string {
  const raw = request.headers['content-type']
  if (typeof raw !== 'string') return ''
  return (raw.split(';')[0] ?? '').trim().toLowerCase()
}

export function pathOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? ''
}

/**
 * Throws 415 unless a body-carrying write uses the content type that route expects.
 * `POST /profiles/import` is the single route that takes raw zip bytes.
 */
export function assertWriteContentType(request: FastifyRequest): void {
  if (!isWriteMethod(request.method) || !hasBody(request)) return

  const contentType = contentTypeOf(request)
  const isImport = pathOf(request) === API_ROUTES.importProfile
  const allowed = isImport
    ? (ZIP_CONTENT_TYPES as readonly string[]).includes(contentType)
    : contentType === 'application/json'

  if (!allowed) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      isImport
        ? `POST ${API_ROUTES.importProfile} requires Content-Type: ${ZIP_CONTENT_TYPES[0]} (got "${contentType || 'none'}")`
        : `Writes must use Content-Type: application/json (got "${contentType || 'none'}")`,
    )
  }
}
