import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { badRequest, ok } from '../errors.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'

function idOf(request: FastifyRequest): string {
  const { id } = request.params as { id?: string }
  if (!id) throw badRequest('Missing profile id in the request path')
  return id
}

export function registerRuntimeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.get(API_ROUTES.runtime, async () => ok(core.runtime.list()))

  app.get(`${API_ROUTES.runtime}/:id`, async request => {
    const profile = await findProfile(core, idOf(request))
    return ok(core.runtime.get(profile.id))
  })
}
