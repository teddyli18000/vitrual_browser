/**
 * The preload contract, shared by the main process (which fills it), the preload (which exposes
 * it) and the renderer (which consumes it). Types and two string constants only — no imports,
 * so it can be pulled into the web, node and preload tsconfigs without dragging Electron types
 * into the renderer.
 */

/** Synchronous channel the preload uses to read the connection facts before the page runs. */
export const BRIDGE_CHANNEL = 'vfox:bridge-info'

export interface ServiceState {
  ok: boolean
  /** Base URL the renderer must talk to, with no trailing slash. */
  url: string
  /** Token for the `x-vfox-token` header. Empty when the service is down. */
  token: string
  /** Human readable reason the service is unavailable, or null. */
  error: string | null
}

export interface ProxyProbe {
  ok: boolean
  /** Round trip time in milliseconds, when the endpoint answered. */
  ms: number | null
  message: string
}

export interface ProfileUsage {
  path: string
  exists: boolean
  bytes: number
  files: number
}

/**
 * Where the data directory came from, so 设置 can tell the user which mode is active.
 *  - `portable`  — next to the executable (a `portable` marker or a `data` directory)
 *  - `installed` — `%APPDATA%\VFox`
 *  - `custom`    — an explicit `VFOX_DATA_DIR` (dev, CI, advanced users)
 */
export type DataMode = 'portable' | 'installed' | 'custom'

/**
 * `window.vfox` — named functions only. No `ipcRenderer`, no `require`, no `process`, no generic
 * `invoke(channel, ...args)`, no filesystem primitive.
 */
export interface VfoxBridge {
  /** `http://127.0.0.1:<port>`, no trailing slash. Empty when the service failed to start. */
  apiBase: string
  /** Sent as the `x-vfox-token` header on every request. */
  token: string
  version: string
  platform: string
  /** Root of the profile store, so 设置 can show and open it. */
  dataDir: string
  dataMode: DataMode
  /** Reason the embedded API is unavailable, or null when it is healthy. */
  serviceError: string | null
  openPath(path: string): Promise<string>
  revealPath(path: string): Promise<boolean>
  /** Opens the one hardcoded first-party homepage; takes no argument on purpose. */
  openHomepage(): Promise<string>
  probeProxy(input: { host: string; port: number }): Promise<ProxyProbe>
  restartService(): Promise<ServiceState>
  profileDir(profileId: string): Promise<string | null>
  profileUsage(profileId: string): Promise<ProfileUsage>
  saveExport(input: {
    suggestedName: string
    base64: string
  }): Promise<{ saved: boolean; path: string | null }>
  pickImport(): Promise<{ name: string; base64: string } | null>
}

/** Shape carried over `BRIDGE_CHANNEL`; the bridge minus the callable capabilities. */
export interface BridgePayload {
  apiBase: string
  token: string
  version: string
  platform: string
  dataDir: string
  dataMode: DataMode
  serviceError: string | null
}
