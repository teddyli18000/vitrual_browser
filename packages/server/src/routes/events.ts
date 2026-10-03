import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { corsHeaders } from '../cors.js'
import type { RouteDeps } from '../types.js'

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // Registered under the same token hook as every other route: an event stream leaks profile
  // activity, so it is not public. The hub owns the socket from here on.
  app.get(API_ROUTES.events, async (request, reply) => {
    // A hijacked reply skips `onSend`, so the CORS headers have to be set on the raw response
    // before the hub writes its own head. `writeHead` merges with what `setHeader` already holds,
    // which is what lets a cross-origin `EventSource` in the renderer connect at all.
    for (const [name, value] of Object.entries(corsHeaders(request))) {
      reply.raw.setHeader(name, value)
    }
    deps.hub.handle(request, reply)
  })
}
