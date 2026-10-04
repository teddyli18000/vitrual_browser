import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { ok } from '../errors.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { profileIdOf, RUNTIME_ID } from './params.js'

export function registerRuntimeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.get(API_ROUTES.runtime, async () => ok(core.runtime.list()))

  app.get(RUNTIME_ID, async request => {
    const profile = await findProfile(core, profileIdOf(request))
    return ok(core.runtime.get(profile.id))
  })
}
