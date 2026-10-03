import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'

import type { Core } from '@vfox/core'
import type { Profile, ProfileRuntime } from '@vfox/shared'
import { API_ROUTES, ProfileCreateSchema, ProfileUpdateSchema } from '@vfox/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { badRequest, conflict, ok } from '../errors.js'
import { contentDisposition, removeFile, sanitizeFilename, stagingPath } from '../files.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'

/** `{ name? }` for `POST /profiles/:id/clone`. */
const CloneBodySchema = z.object({ name: z.string().min(1).max(120).optional() })

/**
 * Body cap for `POST /profiles/import` only. The global cap stays at Fastify's 1 MiB default, so
 * the one route that legitimately receives a large payload is the one that opts into it.
 */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024

/**
 * Fastify route patterns are composed from the collection route plus the parameter segment.
 * The `API_ROUTES` helpers (`profile(id)`, `launchProfile(id)`, ...) are for *clients* building a
 * concrete URL: they run the id through `encodeURIComponent`, so passing them a literal `':id'`
 * would register the path `/profiles/%3Aid/launch` and never match a real request.
 */
export const PROFILE_ID = `${API_ROUTES.profiles}/:id`

/** Fastify's router already URL-decodes params; decoding twice would turn `%2F` into a separator. */
function idOf(request: FastifyRequest): string {
  const { id } = request.params as { id?: string }
  if (!id) throw badRequest('Missing profile id in the request path')
  return id
}

export function registerProfileRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.get(API_ROUTES.profiles, async () => ok(await core.profiles.list()))

  app.post(API_ROUTES.profiles, async (request, reply) => {
    const input = parse(ProfileCreateSchema, request.body)
    const profile = await core.profiles.create(input)
    reply.code(201)
    return ok(profile)
  })

  app.get(PROFILE_ID, async (request) => ok(await findProfile(core, idOf(request))))

  app.patch(PROFILE_ID, async (request) => {
    const profile = await findProfile(core, idOf(request))
    const patch = parse(ProfileUpdateSchema, request.body)
    return ok(await core.profiles.update(profile.id, patch))
  })

  app.delete(PROFILE_ID, async (request) => {
    const profile = await findProfile(core, idOf(request))
    const runtime = core.runtime.get(profile.id)
    if (runtime.status === 'running' || runtime.status === 'starting') {
      throw conflict(`Profile "${profile.name}" is ${runtime.status} — stop it before removing it`)
    }
    await core.profiles.remove(profile.id)
    return ok({ id: profile.id, removed: true })
  })

  app.post(`${PROFILE_ID}/clone`, async (request, reply) => {
    const profile = await findProfile(core, idOf(request))
    const body = parse(CloneBodySchema, request.body ?? {})
    const clone = await core.profiles.clone(profile.id, body.name)
    reply.code(201)
    return ok(clone)
  })

  app.post(`${PROFILE_ID}/launch`, async (request) => {
    const profile = await findProfile(core, idOf(request))
    return ok(await launch(core, profile))
  })

  app.post(`${PROFILE_ID}/stop`, async (request) => {
    const profile = await findProfile(core, idOf(request))
    const current = core.runtime.get(profile.id)
    // Stopping an already stopped profile is a no-op, not an error.
    if (current.status === 'stopped') return ok(current)
    return ok(await core.runtime.stop(profile.id))
  })

  /**
   * The one route that answers with raw bytes instead of the `ApiResult` envelope: a zip download
   * that a browser or `curl -O` can consume directly.
   */
  app.get(`${PROFILE_ID}/export`, async (request, reply) => {
    const profile = await findProfile(core, idOf(request))
    const file = await stagingPath(core, `export-${profile.id}`, '.zip')
    try {
      await core.profiles.exportZip(profile.id, file)
      const { size } = await stat(file)
      const filename = `${sanitizeFilename(profile.name)}.zip`
      const stream = createReadStream(file)
      stream.on('close', () => {
        void removeFile(file)
      })
      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header('content-length', String(size))
        .header('content-disposition', contentDisposition(filename))
        .send(stream)
    } catch (error) {
      await removeFile(file)
      throw error
    }
  })

  app.post(API_ROUTES.importProfile, { bodyLimit: MAX_IMPORT_BYTES }, async (request, reply) => {
    const body = request.body
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw badRequest(
        'Expected raw zip bytes in the request body (Content-Type: application/zip)',
      )
    }
    const { name } = request.query as { name?: string }
    const file = await stagingPath(core, 'import', '.zip')
    await writeFile(file, body)
    try {
      const profile = await core.profiles.importZip(file, name)
      reply.code(201)
      return ok(profile)
    } finally {
      await removeFile(file)
    }
  })
}

/** Shared by the native route and the VirtualBrowser-compatible alias. */
export async function launch(core: Core, profile: Profile): Promise<ProfileRuntime> {
  const current = core.runtime.get(profile.id)
  if (current.status === 'running' || current.status === 'starting') {
    throw conflict(`Profile "${profile.name}" is already ${current.status}`)
  }
  return core.runtime.launch(profile.id)
}
