import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { ok } from '../errors.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'
import { GROUP_ID, groupIdOf } from './params.js'

const GroupNameSchema = z.object({ name: z.string().min(1).max(120) })

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
    return ok(await core.groups.rename(groupIdOf(request), name))
  })

  app.delete(GROUP_ID, async request => {
    const id = groupIdOf(request)
    await core.groups.remove(id)
    return ok({ id, removed: true })
  })
}
