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
  /** POST ProfileBatchCreate -> Profile[] (creation order). One request, `count` profiles. */
  createProfilesBatch: `${API_PREFIX}/profiles/batch`,
  profile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}`,
  launchProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/launch`,
  stopProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/stop`,
  /** POST { name? } -> Profile. Copies config + the whole isolated userdata directory. */
  cloneProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/clone`,
  /** GET -> application/zip (config + userdata). The VM-style "export the machine" action. */
  exportProfile: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/export`,
  /** POST body = raw zip bytes (Content-Type: application/zip) -> Profile. */
  importProfile: `${API_PREFIX}/profiles/import`,

  /**
   * GET -> `text/plain` Netscape `cookies.txt` (NOT the ApiResult envelope), so `curl -O` and every
   * other tool that speaks the format can consume it directly.
   */
  exportCookies: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/cookies/export`,
  /** POST CookieImportRequest (JSON) -> CookieImportResult. */
  importCookies: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/cookies/import`,

  /**
   * GET -> ProfileAddon[] (the addons VFox manages plus the engine's own defaults, which are
   * read-only). Readable while the profile runs: the store is an inert directory on disk that no
   * browser holds open, unlike `cookies.sqlite`.
   */
  profileAddons: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/addons`,
  /** POST AddonInstallRequest -> ProfileAddon. Refused (409) while the profile runs. */
  installAddon: (id: string) => `${API_PREFIX}/profiles/${encodeURIComponent(id)}/addons`,
  /** DELETE -> { removed: ProfileAddon }. `slug` is the record's slug or its gecko id. */
  profileAddon: (id: string, slug: string) =>
    `${API_PREFIX}/profiles/${encodeURIComponent(id)}/addons/${encodeURIComponent(slug)}`,

  runtime: `${API_PREFIX}/runtime`,
  runtimeFor: (id: string) => `${API_PREFIX}/runtime/${encodeURIComponent(id)}`,

  groups: `${API_PREFIX}/groups`,
  group: (id: string) => `${API_PREFIX}/groups/${encodeURIComponent(id)}`,

  /** Engine status: GET -> KernelInfo (every installed kernel, the default one, and their sizes). */
  kernel: `${API_PREFIX}/kernel`,
  /**
   * POST `{ version? }` -> `{ started: true }` immediately (409 when already installing); progress is
   * pushed on the `kernel` SSE event. A 550 MB download must never block an HTTP response.
   *
   * `version` must be one of the versions this build was tested against; omitting it installs the
   * preferred one. Installing a version that is already present is a no-op, and installing never
   * re-points an existing profile.
   */
  kernelInstall: `${API_PREFIX}/kernel/install`,
  /**
   * POST `{ version }` -> KernelInfo. 409 with the profile names when a profile pins that kernel or a
   * browser is running from it, 404 when it is not installed.
   */
  kernelRemove: `${API_PREFIX}/kernel/remove`,

  /* Window synchroniser — input in the master profile is replayed into every slave profile. */
  /** GET -> SyncSession | null */
  sync: `${API_PREFIX}/sync`,
  /** POST SyncStart -> SyncSession */
  syncStart: `${API_PREFIX}/sync/start`,
  /** POST -> { ok: true } */
  syncStop: `${API_PREFIX}/sync/stop`,
  /** POST TileRequest -> { ok: true } (arrange the given windows in a grid/rows/columns) */
  syncTile: `${API_PREFIX}/sync/tile`,

  /** Server-sent events: runtime status transitions. */
  events: `${API_PREFIX}/events`,

  /** VirtualBrowser-compatible aliases (POST { id } -> { success, data }). */
  launchBrowser: `${API_PREFIX}/launchBrowser`,
  closeBrowser: `${API_PREFIX}/closeBrowser`,
  browserList: `${API_PREFIX}/browserList`,
} as const

export const SSE_EVENT_RUNTIME = 'runtime'
export const SSE_EVENT_KERNEL = 'kernel'
export const SSE_EVENT_SYNC = 'sync'
