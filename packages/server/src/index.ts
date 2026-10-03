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

export type { CreateAppOptions } from './app.js'
export { createApp, MAX_IMPORT_BYTES, startServer } from './app.js'
export {
  allowedOrigin,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  corsHeaders,
  isAllowedHost,
} from './cors.js'
export { fail, HttpError, ok } from './errors.js'
export type { EventHubOptions } from './events.js'
export { EventHub } from './events.js'
export {
  createRotatingLogger,
  DEFAULT_MAX_BYTES as LOG_MAX_BYTES,
  DEFAULT_MAX_FILES as LOG_MAX_FILES,
  logFilePath,
} from './file-logger.js'
export { assertWriteContentType, ZIP_CONTENT_TYPES } from './guards.js'
export { consoleLogger, createFanoutLogger, silentLogger } from './logger.js'
export { createMcpServer, MCP_PATH, registerMcpRoute } from './mcp.js'
export {
  API_TOKEN_FILE,
  apiTokenPath,
  PORTABLE_DATA_DIR,
  PORTABLE_MARKER,
  portableDataDir,
  resolveDataDir,
} from './paths.js'
export { looksLikeProfileId, PROFILE_ID_PATTERN } from './resolve.js'
export { serveMcpStdio } from './stdio.js'
export type { ResolvedToken, TokenSource } from './token.js'
export { resolveToken, tokenMatches } from './token.js'
export type { AppContext, RouteDeps, ServerHandle, ServerOptions } from './types.js'
export { packageVersion } from './version.js'
