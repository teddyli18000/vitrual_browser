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
    // AWAITED, and the await is load-bearing rather than stylistic. `handle` reads the runtime
    // snapshot from the store before it hijacks the reply, so it now yields control on its first
    // line. Dropping the promise here lets the async handler resolve immediately, Fastify sends its
    // own empty 200, and `handle` then dies on `res.writeHead(200, ...)` with ERR_HTTP_HEADERS_SENT.
    //
    // That is exactly what shipped in the store PR: before it, `handle` reached `reply.hijack()`
    // without ever yielding, so the missing await was invisible. CI caught it on the real SSE route
    // while the unit suite stayed green, because the suite drives a fake hub.
    await deps.hub.handle(request, reply)
  })
}
