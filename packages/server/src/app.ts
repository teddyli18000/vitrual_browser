/**
 * Builds the Fastify application: auth, envelope error handling, every route in `API_ROUTES`,
 * the SSE hub and the MCP endpoint.
 *
 * The app is created *without* listening so tests can drive it with `app.inject()` and so
 * `startServer()` can pick a port (including the ephemeral-port fallback) before going live.
 */

import type { Core, CoreLogger } from '@vfox/core'
import { API_PREFIX, API_TOKEN_HEADER, DEFAULT_API_HOST, DEFAULT_API_PORT, ENV } from '@vfox/shared'
import type { SyncHandle } from '@vfox/sync'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { answerPreflight, applyCors, assertOriginAllowed, isAllowedHost } from './cors.js'
import { fail, HttpError, unauthorized } from './errors.js'
import { EventHub } from './events.js'
import { createRotatingLogger, logFilePath } from './file-logger.js'
import { assertWriteContentType, pathOf, ZIP_CONTENT_TYPES } from './guards.js'
import { createFanoutLogger, silentLogger } from './logger.js'
import { MCP_PATH, registerMcpRoute } from './mcp.js'
import { apiTokenPath, resolveDataDir } from './paths.js'
import { registerRoutes } from './routes/index.js'
import { resolveToken, tokenMatches } from './token.js'
import type { AppContext, ServerHandle, ServerOptions } from './types.js'

/** Route-level cap for `POST /profiles/import`; the global cap stays at Fastify's 1 MiB default. */
export { MAX_IMPORT_BYTES } from './routes/profiles.js'

export interface CreateAppOptions {
  core: Core
  token: string
  /**
   * The window synchroniser the sync routes drive. `startServer` constructs the real one; the
   * tests inject a fake handle so no route ever needs a browser.
   */
  sync: SyncHandle
  logger?: CoreLogger
  /** SSE keepalive interval in ms; 0 disables it. */
  heartbeatMs?: number
}

export async function createApp(options: CreateAppOptions): Promise<AppContext> {
  const logger = options.logger ?? silentLogger
  const core = options.core
  const token = options.token
  const sync = options.sync

  // No request logging: this is a local loopback API, and the product ships no telemetry.
  const app = Fastify({ logger: false })

  const hub = new EventHub({ core, sync, logger, heartbeatMs: options.heartbeatMs })
  hub.start()

  // 1. Loopback `Host` allowlist. This — not CORS — is the DNS-rebinding defence: an attacker's
  //    page is same-origin with the rebound name, so only the Host header gives it away.
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request)) {
      throw new HttpError(
        403,
        'forbidden_host',
        `Refusing a request whose Host is "${request.headers.host ?? ''}" — the VFox API answers loopback host names only`,
      )
    }
    // 2. State-changing requests from a disallowed origin are refused outright. Omitting the CORS
    //    headers only stops a browser *reading* the answer; the write would already have happened.
    assertOriginAllowed(request)
    // 3. CORS preflight, answered before the token check. A browser never attaches the token to a
    //    preflight, so requiring it here would reject every cross-origin call from the renderer.
    if (isApiPath(request) && request.method === 'OPTIONS') {
      return answerPreflight(reply, request)
    }
    return undefined
  })

  // 4. Token check for everything that is not a preflight.
  app.addHook('onRequest', async request => {
    if (!isProtected(request)) return
    if (!tokenMatches(providedToken(request), token)) throw unauthorized()
  })

  // 5. Body content type. A cross-site HTML form can only send the three CORS-safelisted content
  //    types, so requiring JSON on body-carrying writes makes that whole attack class fail here,
  //    before any handler or the core sees it.
  app.addHook('onRequest', async request => {
    if (!isProtected(request)) return
    assertWriteContentType(request)
  })

  // 6. CORS on real responses, including errors: a 401 without the header shows up in the renderer
  //    as an opaque network failure instead of a readable message.
  app.addHook('onSend', async (request, reply, payload) => {
    if (isApiPath(request)) applyCors(reply, request)
    return payload
  })

  // 6. Every rejected request lands in the log with method, path and status. 5xx is logged with its
  //    error detail by the error handler below, so this covers the 4xx side.
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400 || reply.statusCode >= 500) return
    logger.warn(`request rejected: ${request.method} ${pathOf(request)} -> ${reply.statusCode}`)
  })

  // `POST /profiles/import` receives raw zip bytes; Fastify has no parser for that by default.
  for (const contentType of ZIP_CONTENT_TYPES) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body)
    })
  }

  // A write with NO body is legitimate — `POST /kernel/install`, `POST /profiles/:id/launch` and
  // `POST /profiles/:id/stop` are actions, not documents. Fastify's built-in JSON parser rejects
  // that combination outright:
  //
  //     Body cannot be empty when content-type is set to 'application/json'
  //
  // which is exactly what broke the GUI's 一键安装 button on first run: every profile and kernel
  // action was unreachable, and first run could never install the engine. Treating an empty payload
  // as `{}` fixes it for every client at once — the GUI, the CLI and a hand-written curl — rather
  // than relying on each caller to omit the header. A route that genuinely requires fields still
  // fails, with a schema error that names them instead of a parser error that names nothing.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (text === '') {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch (error) {
      // Fastify's built-in parser tags a malformed body as 400; a plain Error would surface as a
      // 500 through our error handler, which would tell the caller nothing useful.
      const malformed = error as Error & { statusCode?: number }
      malformed.statusCode = 400
      done(malformed, undefined)
    }
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) {
        logger.error(`${request.method} ${pathOf(request)} -> ${error.statusCode} ${error.message}`)
      }
      reply.code(error.statusCode).send(fail(error.toApiError()))
      return
    }
    const statusCode = httpStatus(error)
    if (statusCode >= 500) {
      logger.error(
        `${request.method} ${pathOf(request)} -> ${statusCode} ${errorMessage(error)}`,
        error,
      )
    }
    reply.code(statusCode).send(fail({ code: errorCode(statusCode), message: errorMessage(error) }))
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      fail({
        code: 'not_found',
        message: `No route for ${request.method} ${request.url}`,
      }),
    )
  })

  registerRoutes(app, { core, sync, hub, logger })
  registerMcpRoute(app, core, logger)

  await app.ready()

  return {
    app,
    core,
    token,
    hub,
    // HTTP only: `startServer`'s handle adds `core.close()` on top of this.
    close: async () => {
      hub.stop()
      await app.close()
    },
  }
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  if (!options || typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
    throw new Error('startServer: `dataDir` is required')
  }

  const dataDir = resolveDataDir(options.dataDir)
  const host = options.host ?? process.env[ENV.apiHost] ?? DEFAULT_API_HOST
  // The rotating file log is always on: the desktop app's "copy diagnostics" action reads it. The
  // caller's own logger, if any, is fanned out alongside it.
  const logger = createFanoutLogger(
    createRotatingLogger({ dataDir }),
    options.logger ?? silentLogger,
  )
  const { token, generated, source } = await resolveToken({ dataDir, token: options.token })
  const core = options.core ?? (await loadCore(dataDir, logger))
  // Exactly one synchroniser for the whole process: it owns the master/slave links and the session
  // state, so a second instance would fight this one for the same windows.
  const sync = await loadSync(core, logger)

  let context = await createApp({ core, token, sync, logger })

  const envPort = envApiPort()
  const explicitPort = options.port !== undefined || envPort !== undefined
  const wanted = options.port ?? envPort ?? DEFAULT_API_PORT
  let port = wanted

  try {
    await context.app.listen({ host, port: wanted })
  } catch (error) {
    if (explicitPort || !isAddrInUse(error)) {
      logger.error(`failed to bind ${host}:${wanted}`, error)
      await context.close()
      await sync.close()
      await core.close()
      throw error
    }
    // Port 9000 is commonly squatted (Xdebug, PHP-FPM, Portainer, SonarQube, ClickHouse, MinIO...).
    // Bind an ephemeral port instead of crashing; the real port is reported in this handle.
    logger.warn(`port ${wanted} is in use — falling back to an ephemeral port`)
    await context.close()
    context = await createApp({ core, token, sync, logger })
    port = 0
    await context.app.listen({ host, port })
  }

  const actualPort = listeningPort(context.app, port)
  const url = `http://${host}:${actualPort}`
  logger.info(`vfox api listening on ${url}`)
  // Never the token value — only where it came from.
  logger.info(`api token: present (source: ${source})`)
  if (generated) {
    logger.info(`api token generated and stored in ${apiTokenPath(dataDir)}`)
  }
  logger.info(`log file: ${logFilePath(dataDir)}`)

  return {
    host,
    port: actualPort,
    token,
    url,
    // Frozen contract: the handle owns the HTTP server, the synchroniser and the core. Order
    // matters — the HTTP server stops first so no new sync request can arrive, then the
    // synchroniser detaches from the browsers, and only then does the core stop them.
    close: async () => {
      await context.close()
      await sync.close()
      await core.close()
    },
  }
}

/**
 * Loaded lazily so that embedding or testing this package never pulls the synchroniser (and
 * Playwright behind it) in: the tests inject a fake handle through `createApp`, and a package that
 * is installed without `@vfox/sync` built must still be able to import this one.
 */
async function loadSync(core: Core, logger: CoreLogger): Promise<SyncHandle> {
  const { createSync } = await import('@vfox/sync')
  return createSync({
    /**
     * The runtime registry is the only place that knows a profile's live `wsEndpoint` and pid.
     * `runtime.get()` answers with a synthetic `stopped` runtime for an id the store does not
     * know, so membership is decided by the store instead: an unknown profile has to resolve to
     * `undefined` (-> SyncError `unknown_profile`, 404) rather than to "not running" (409), which
     * is a different failure the user fixes differently.
     *
     * Asynchronous because the store reads `profiles.json` per call, so a profile created by
     * another process is reachable here without restarting the server.
     */
    resolve: async profileId => {
      const profile = await core.profiles.get(profileId)
      if (!profile) return undefined
      const runtime = core.runtime.get(profile.id)
      return { wsEndpoint: runtime.wsEndpoint, pid: runtime.pid }
    },
    logger,
  })
}

/**
 * Loaded lazily so that embedding or testing this package never pulls the engine in: the tests
 * always inject a fake core, and the CLI's `--help` must work before `@vfox/core` is built.
 */
async function loadCore(dataDir: string, logger: CoreLogger): Promise<Core> {
  const { createCore } = await import('@vfox/core')
  return createCore({ dataDir, logger })
}

function isProtected(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? ''
  return path === MCP_PATH || path.startsWith(API_PREFIX)
}

/** Browser-facing surface. `/mcp` is a machine-to-machine endpoint and needs no CORS. */
function isApiPath(request: FastifyRequest): boolean {
  return (request.url.split('?')[0] ?? '').startsWith(API_PREFIX)
}

/**
 * `x-vfox-token` is the documented header. `Authorization: Bearer <same token>` is accepted as an
 * alias so stock MCP clients (which do not know a custom header) can reach `/mcp`. Same token,
 * same constant-time comparison, no separate code path.
 */
function providedToken(request: FastifyRequest): string | undefined {
  const raw = request.headers[API_TOKEN_HEADER]
  const direct = Array.isArray(raw) ? raw[0] : raw
  if (typeof direct === 'string' && direct.length > 0) return direct

  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim()
  }
  return undefined
}

function envApiPort(): number | undefined {
  const raw = process.env[ENV.apiPort]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined
}

function isAddrInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE'
}

function listeningPort(app: FastifyInstance, fallback: number): number {
  const address = app.server.address()
  return typeof address === 'object' && address !== null ? address.port : fallback
}

function httpStatus(error: unknown): number {
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return 'Internal error'
}

function errorCode(status: number): string {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'payload_too_large'
    case 415:
      return 'unsupported_media_type'
    default:
      return status >= 500 ? 'internal_error' : 'bad_request'
  }
}
