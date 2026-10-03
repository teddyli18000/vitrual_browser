/**
 * HTTP contract shared by the core service, the desktop app and the CLI.
 * Changing a path here is a breaking change for every consumer — update all three at once.
 */

export const API_PREFIX = '/api/v1'

/** VirtualBrowser-compatible default so existing automation scripts keep working. */
export const DEFAULT_API_PORT = 9000

/** Loopback-only by default. Binding to 0.0.0.0 requires an explicit token. */
export const DEFAULT_API_HOST = '127.0.0.1'

export const API_TOKEN_HEADER = 'x-vfox-token'

export const API_ROUTES = {
  health: `${API_PREFIX}/health`,

  profiles: `${API_PREFIX}/profiles`,
  profile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}`,
  launchProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/launch`,
  stopProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/stop`,

  runtime: `${API_PREFIX}/runtime`,
  runtimeFor: (id: string) => `${API_PREFIX}/runtime/${encodeURIComponent(id)}`,

  groups: `${API_PREFIX}/groups`,
  group: (id: string) => `${API_PREFIX}/groups/${encodeURIComponent(id)}`,

  /** Server-sent events: runtime status transitions. */
  events: `${API_PREFIX}/events`,

  /** VirtualBrowser-compatible aliases (POST { id } -> { success, data }). */
  launchBrowser: `${API_PREFIX}/launchBrowser`,
  closeBrowser: `${API_PREFIX}/closeBrowser`,
  browserList: `${API_PREFIX}/browserList`,
} as const

export const SSE_EVENT_RUNTIME = 'runtime'
export const SSE_EVENT_KERNEL = 'kernel'
