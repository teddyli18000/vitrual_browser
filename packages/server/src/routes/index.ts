import type { FastifyInstance } from 'fastify'

import type { RouteDeps } from '../types.js'
import { registerAddonRoutes } from './addons.js'
import { registerCompatRoutes } from './compat.js'
import { registerCookieRoutes } from './cookies.js'
import { registerEventRoutes } from './events.js'
import { registerGroupRoutes } from './groups.js'
import { registerHealthRoutes } from './health.js'
import { registerKernelRoutes } from './kernel.js'
import { registerProfileRoutes } from './profiles.js'
import { registerRuntimeRoutes } from './runtime.js'
import { registerSyncRoutes } from './sync.js'

/**
 * Registers every route in `API_ROUTES` plus the VirtualBrowser-compatible aliases.
 * Paths come from the shared route table — nothing is spelled out twice.
 *
 * This is the single place route modules are wired in. A module that nothing imports here is
 * silently a 404 — no typecheck can see it, and only a request against the real server finds it.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerHealthRoutes(app, deps.core)
  registerProfileRoutes(app, deps)
  registerCookieRoutes(app, deps)
  registerAddonRoutes(app, deps)
  registerRuntimeRoutes(app, deps)
  registerGroupRoutes(app, deps)
  registerKernelRoutes(app, deps)
  registerSyncRoutes(app, deps)
  registerCompatRoutes(app, deps)
  registerEventRoutes(app, deps)
}
