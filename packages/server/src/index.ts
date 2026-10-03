/**
 * `@vfox/server` — the VFox HTTP API, SSE stream and MCP endpoint.
 *
 * Frozen in-process surface (see AGENTS.md); `apps/desktop` calls `startServer` from the Electron
 * main process and uses `ServerHandle.url` as its API base:
 *
 * ```ts
 * const handle = await startServer({ dataDir: app.getPath('userData') })
 * // handle.url   -> 'http://127.0.0.1:9000'
 * // handle.token -> required in the `x-vfox-token` header
 * await handle.close()   // stops the HTTP server *and* the core
 * ```
 *
 * This package never imports Electron.
 */

export { startServer, createApp, MAX_IMPORT_BYTES } from './app.js'
export type { CreateAppOptions } from './app.js'
export {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  allowedOrigin,
  corsHeaders,
  isAllowedHost,
} from './cors.js'
export { EventHub } from './events.js'
export type { EventHubOptions } from './events.js'
export { HttpError, fail, ok } from './errors.js'
export {
  DEFAULT_MAX_BYTES as LOG_MAX_BYTES,
  DEFAULT_MAX_FILES as LOG_MAX_FILES,
  createRotatingLogger,
  logFilePath,
} from './file-logger.js'
export { ZIP_CONTENT_TYPES, assertWriteContentType } from './guards.js'
export { createFanoutLogger, consoleLogger, silentLogger } from './logger.js'
export { MCP_PATH, createMcpServer, registerMcpRoute } from './mcp.js'
export { API_TOKEN_FILE, apiTokenPath, resolveDataDir } from './paths.js'
export { PROFILE_ID_PATTERN, looksLikeProfileId } from './resolve.js'
export { serveMcpStdio } from './stdio.js'
export { resolveToken, tokenMatches } from './token.js'
export type { ResolvedToken, TokenSource } from './token.js'
export type { AppContext, RouteDeps, ServerHandle, ServerOptions } from './types.js'
export { packageVersion } from './version.js'
