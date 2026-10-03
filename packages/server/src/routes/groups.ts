import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { badRequest, ok } from '../errors.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'

const GroupNameSchema = z.object({ name: z.string().min(1).max(120) })

/**
 * Composed from the collection route: `API_ROUTES.group(id)` encodes its argument for a *client*,
 * so feeding it a literal `':id'` would register `/groups/%3Aid` and never match.
 */
const GROUP_ID = `${API_ROUTES.groups}/:id`

function idOf(request: FastifyRequest): string {
  const { id } = request.params as { id?: string }
  if (!id) throw badRequest('Missing group id in the request path')
  return id
}

export function registerGroupRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.get(API_ROUTES.groups, async () => ok(await core.groups.list()))

  app.post(API_ROUTES.groups, async (request, reply) => {
    const { name } = parse(GroupNameSchema, request.body)
    const group = await core.groups.create(name)
    reply.code(201)
    return ok(group)
  })

  // Rename. `PATCH /groups/:id { name }` keeps the route table's single `group(id)` entry.
  app.patch(GROUP_ID, async request => {
    const { name } = parse(GroupNameSchema, request.body)
    return ok(await core.groups.rename(idOf(request), name))
  })

  app.delete(GROUP_ID, async request => {
    const id = idOf(request)
    await core.groups.remove(id)
    return ok({ id, removed: true })
  })
}
