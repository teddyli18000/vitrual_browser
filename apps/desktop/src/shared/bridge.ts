/**
 * The preload contract, shared by the main process (which fills it), the preload (which exposes
 * it) and the renderer (which consumes it). Types and two string constants only — no imports,
 * so it can be pulled into the web, node and preload tsconfigs without dragging Electron types
 * into the renderer.
 */

/** `additionalArguments` entry the main process uses to hand the bridge over to the preload. */
export const BRIDGE_ARG_PREFIX = '--vfox-bridge='

export interface VfoxBridge {
  /** `http://127.0.0.1:<port>`, no trailing slash. Empty when the service failed to start. */
  apiBase: string
  /** Sent as the `x-vfox-token` header on every request. */
  token: string
  version: string
  platform: string
  /** Root of the profile store, so 设置 can show and open it. */
  dataDir: string
  /** Reason the embedded API is unavailable, or null when it is healthy. */
  serviceError: string | null
  openPath(path: string): Promise<string>
  revealPath(path: string): Promise<boolean>
  probeProxy(input: { host: string; port: number }): Promise<ProxyProbe>
  restartService(): Promise<ServiceState>
  saveExport(input: { suggestedName: string; base64: string }): Promise<{ saved: boolean; path: string | null }>
  pickImport(): Promise<{ name: string; base64: string } | null>
  profileDir(profileId: string): Promise<string>
}

export interface ProxyProbe {
  ok: boolean
  /** Round trip time in milliseconds, when the endpoint answered. */
  ms: number | null
  message: string
}

export interface ServiceState {
  ok: boolean
  url: string
  token: string
  error: string | null
}

/** Shape carried in `--vfox-bridge=`; identical to the bridge minus the callable capabilities. */
export interface BridgePayload {
  apiBase: string
  token: string
  version: string
  platform: string
  dataDir: string
  serviceError: string | null
}
