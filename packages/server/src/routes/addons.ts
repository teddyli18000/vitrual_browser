import type { Core } from '@vfox/core'
import type { Profile } from '@vfox/shared'
import { AddonInstallRequestSchema } from '@vfox/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { badRequest, conflict, ok } from '../errors.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'
import { PROFILE_ID, profileIdOf } from './params.js'

/**
 * Per-profile addons.
 *
 * `list` answers for a running profile — the store is an inert directory on disk that no browser
 * holds open, so there is nothing to be inconsistent about, and the UI must be able to show what a
 * running profile carries. `install` and `remove` are refused while it runs, because the engine reads
 * the addon list at startup: a change now would take effect only after a restart, and a remove could
 * delete a directory the browser has loaded.
 */
export function registerAddonRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.get(`${PROFILE_ID}/addons`, async request => {
    const profile = await findProfile(core, profileIdOf(request))
    return ok(await core.addons.list(profile.id))
  })

  app.post(`${PROFILE_ID}/addons`, async request => {
    const profile = await findProfile(core, profileIdOf(request))
    requireStopped(core, profile)
    const body = parse(AddonInstallRequestSchema, request.body)
    return ok(await core.addons.install(profile.id, body.path, { replace: body.replace }))
  })

  app.delete(`${PROFILE_ID}/addons/:slug`, async request => {
    const profile = await findProfile(core, profileIdOf(request))
    requireStopped(core, profile)
    return ok({ removed: await core.addons.remove(profile.id, slugOf(request)) })
  })
}

/** Fastify's router already URL-decodes params; decoding twice would turn `%2F` into a separator. */
function slugOf(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>).slug
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('Missing addon slug in the request path')
  }
  return value
}

/** `error` is allowed through: the registry only reaches it with no live process attached. */
function requireStopped(core: Core, profile: Profile): void {
  const { status } = core.runtime.get(profile.id)
  if (status === 'stopped' || status === 'error') return
  throw conflict(
    `Profile "${profile.name}" is ${status} — stop it before installing or removing addons. ` +
      'The engine reads the addon list when it starts, so the change would only take effect after ' +
      'a restart, and removing one could delete files the browser has loaded.',
  )
}
