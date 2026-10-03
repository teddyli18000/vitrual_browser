/**
 * `ApiResult<T>` envelope helpers + the error type routes throw.
 *
 * Every route in this package answers with the frozen envelope from `@vfox/shared`:
 * `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`.
 */

import type { ApiError, ApiResult } from '@vfox/shared'

export function ok<T>(data: T): ApiResult<T> {
  return { success: true, data }
}

export function fail(error: ApiError): ApiResult<never> {
  return { success: false, error }
}

/** Thrown by route handlers; the Fastify error handler turns it into the envelope. */
export class HttpError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }

  toApiError(): ApiError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'bad_request', message, details)

export const unauthorized = (message = 'Missing or invalid API token'): HttpError =>
  new HttpError(401, 'unauthorized', message)

export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message)

export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message)

export const validationError = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'validation_error', message, details)

export const internalError = (message: string): HttpError =>
  new HttpError(500, 'internal_error', message)
