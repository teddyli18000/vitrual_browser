/**
 * Route parameters shared by the route modules.
 *
 * Fastify patterns are composed from the collection route plus the parameter segment. The
 * `API_ROUTES` helpers (`profile(id)`, `launchProfile(id)`, ...) are for *clients* building a
 * concrete URL: they run the id through `encodeURIComponent`, so passing one a literal `':id'`
 * would register the path `/profiles/%3Aid/launch` and never match a real request.
 */

import { API_ROUTES } from '@vfox/shared'
import type { FastifyRequest } from 'fastify'

import { badRequest } from '../errors.js'

export const PROFILE_ID = `${API_ROUTES.profiles}/:id`
export const GROUP_ID = `${API_ROUTES.groups}/:id`
export const RUNTIME_ID = `${API_ROUTES.runtime}/:id`

/** Fastify's router already URL-decodes params; decoding twice would turn `%2F` into a separator. */
export function profileIdOf(request: FastifyRequest): string {
  return pathParam(request, 'id', 'Missing profile id in the request path')
}

export function groupIdOf(request: FastifyRequest): string {
  return pathParam(request, 'id', 'Missing group id in the request path')
}

function pathParam(request: FastifyRequest, name: string, message: string): string {
  const value = (request.params as Record<string, unknown>)[name]
  if (typeof value !== 'string' || value.length === 0) throw badRequest(message)
  return value
}
