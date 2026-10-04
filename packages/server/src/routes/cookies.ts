import type { Core } from '@vfox/core'
import type { Profile } from '@vfox/shared'
import { CookieImportRequestSchema } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { conflict, ok } from '../errors.js'
import { contentDisposition, sanitizeFilename } from '../files.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'
import { PROFILE_ID, profileIdOf } from './params.js'

/**
 * Cookie import/export — the "register in profile A, move the session to profile B" workflow.
 *
 * Both directions work on a **stopped** profile, because the cookie jar of record is
 * `<userdata>/cookies.sqlite` and a running browser owns that file: it holds it open and keeps its
 * own in-memory jar, so anything written from outside would be lost or fought over. Reading it
 * through the engine instead would mean launching a browser per profile, which is exactly what a
 * user exporting fifty profiles must not pay.
 */
export function registerCookieRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  /**
   * Raw `text/plain`, like the profile-zip route and for the same reason: `curl -O` and every other
   * tool that speaks the format should be able to consume the response directly. Not the envelope.
   */
  app.get(`${PROFILE_ID}/cookies/export`, async (request, reply) => {
    const profile = await findProfile(core, profileIdOf(request))
    requireStopped(core, profile)
    const exported = await core.cookies.export(profile.id)

    return reply
      .code(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-length', String(Buffer.byteLength(exported.content, 'utf8')))
      .header(
        'content-disposition',
        contentDisposition(`${sanitizeFilename(profile.name)}.cookies.txt`),
      )
      .send(exported.content)
  })

  /**
   * JSON body, not the raw file: `text/plain` is CORS-safelisted, so accepting it here would let a
   * cross-site form POST a cookie file. `application/json` is already the rule for every
   * body-carrying write (see `guards.ts`), so this needs no exception.
   */
  app.post(`${PROFILE_ID}/cookies/import`, async request => {
    const profile = await findProfile(core, profileIdOf(request))
    requireStopped(core, profile)
    const body = parse(CookieImportRequestSchema, request.body)
    return ok(await core.cookies.import(profile.id, body.content, { mode: body.mode }))
  })
}

/** `error` is allowed through: the registry only reaches it with no live process attached. */
function requireStopped(core: Core, profile: Profile): void {
  const { status } = core.runtime.get(profile.id)
  if (status === 'stopped' || status === 'error') return
  throw conflict(
    `Profile "${profile.name}" is ${status} — stop it before exporting or importing cookies. ` +
      'The cookie store on disk is what is read and written, and a running browser owns it.',
  )
}
