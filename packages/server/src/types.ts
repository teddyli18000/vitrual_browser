/**
 * Public types of `@vfox/server`.
 *
 * `ServerOptions` / `ServerHandle` are the frozen in-process surface the Electron main process
 * calls (see AGENTS.md) — do not change them without updating `apps/desktop`.
 */

import type { Core, CoreLogger } from '@vfox/core'
import type { SyncHandle } from '@vfox/sync'
import type { FastifyInstance } from 'fastify'

import type { EventHub } from './events.js'

export interface ServerOptions {
  /** Root of all persisted state. The desktop passes `app.getPath('userData')`. */
  dataDir: string
  /** Defaults to `DEFAULT_API_PORT` (9000); falls back to an ephemeral port when 9000 is taken. */
  port?: number
  /** Defaults to `DEFAULT_API_HOST` (127.0.0.1). */
  host?: string
  /** Defaults to `VFOX_API_TOKEN`, then `<dataDir>/api-token`, then a freshly generated token. */
  token?: string
  logger?: CoreLogger
  /**
   * Test/embedding hook: reuse an already constructed core instead of creating one. The server
   * still closes it on `close()`, exactly as it closes the one it created itself.
   */
  core?: Core
}

export interface ServerHandle {
  host: string
  port: number
  token: string
  /** `http://<host>:<port>` — the API base the GUI and the CLI talk to. */
  url: string
  close(): Promise<void>
}

/** Everything a route needs. Assembled once by `createApp`. */
export interface RouteDeps {
  core: Core
  /**
   * The window synchroniser. Constructed **once** by `startServer` over the core's runtime
   * registry; injected here so the tests can drive every route with a fake handle and never touch
   * a browser.
   */
  sync: SyncHandle
  /** SSE fan-out. Runtime changes are wired in `EventHub.start()`; routes publish kernel progress. */
  hub: EventHub
  logger: CoreLogger
}

/** An app built but not yet listening — used by the tests and by `startServer`. */
export interface AppContext {
  app: FastifyInstance
  core: Core
  token: string
  hub: EventHub
  close(): Promise<void>
}
