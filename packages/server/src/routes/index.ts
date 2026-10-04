import type { FastifyInstance } from 'fastify'

import type { RouteDeps } from '../types.js'
import { registerCompatRoutes } from './compat.js'
import { registerCookieRoutes } from './cookies.js'
import { registerEventRoutes } from './events.js'
import { registerGroupRoutes } from './groups.js'
import { registerHealthRoutes } from './health.js'
import { registerKernelRoutes } from './kernel.js'
import { registerProfileRoutes } from './profiles.js'
import { registerRuntimeRoutes } from './runtime.js'

/**
 * Registers every route in `API_ROUTES` plus the VirtualBrowser-compatible aliases.
 * Paths come from the shared route table — nothing is spelled out twice.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerHealthRoutes(app, deps.core)
  registerProfileRoutes(app, deps)
  registerCookieRoutes(app, deps)
  registerRuntimeRoutes(app, deps)
  registerGroupRoutes(app, deps)
  registerKernelRoutes(app, deps)
  registerCompatRoutes(app, deps)
  registerEventRoutes(app, deps)
}
