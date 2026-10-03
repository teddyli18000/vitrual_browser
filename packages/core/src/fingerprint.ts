/**
 * `FingerprintConfig` -> camoufox-js launch options.
 *
 * The accepted option shape is the destructured parameter list of
 * `node_modules/camoufox-js/dist/utils.js:launchOptions()` (0.12.0), and the CAMOU_CONFIG keys
 * we add by hand are taken from the installed engine's own schema (`properties.json` +
 * `camoucfg.jvv`), because camoufox-js validates every key against it and throws
 * `UnknownProperty` for anything else.
 *
 * Two shared-contract fields have no engine equivalent and are reported instead of faked:
 * `deviceMemory` (Firefox has no `navigator.deviceMemory`; camoufox-js's own
 * `mappings/browserforge.config.js` says "deviceMemory not in Firefox") and, by the same
 * reason, nothing else — every other field maps 1:1.
 */

import type { FingerprintConfig, ProxyConfig, ScreenConstraint } from '@vfox/shared'

/** Shape accepted by camoufox-js's `proxy` option. */
export interface EngineProxy {
  server: string
  username?: string
  password?: string
}

/** The subset of camoufox-js `LaunchOptions` that VFox drives. */
export interface EngineOptions {
  os: FingerprintConfig['os']
  /** camoufox-js takes `undefined` for "let the engine generate one", never `null`. */
  screen: ScreenConstraint | undefined
  window: [number, number] | undefined
  webgl_config: [string, string] | undefined
  fonts: string[] | undefined
  locale: string | undefined
  geoip: boolean
  humanize: boolean
  block_images: boolean
  block_webrtc: boolean
  block_webgl: boolean
  disable_coop: boolean
  /** Raw CAMOU_CONFIG escape hatch, merged last so it wins over the derived keys. */
  config: Record<string, unknown>
  proxy: EngineProxy | undefined
}

export type FingerprintWarning = (message: string) => void

/** `{ type, host, port, username, password }` -> `{ server: '<type>://<host>:<port>', ... }`. */
export function toEngineProxy(proxy: ProxyConfig | null | undefined): EngineProxy | undefined {
  if (!proxy) {
    return undefined
  }
  return {
    server: `${proxy.type}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password,
  }
}

export function toEngineOptions(
  fingerprint: FingerprintConfig,
  proxy: ProxyConfig | null,
  warn?: FingerprintWarning,
): EngineOptions {
  const derived: Record<string, unknown> = {}
  if (fingerprint.hardwareConcurrency !== null) {
    derived['navigator.hardwareConcurrency'] = fingerprint.hardwareConcurrency
  }
  if (fingerprint.userAgent !== null) {
    // camoufox-js's mapping notes that `headers.User-Agent` is redundant with
    // `navigator.userAgent`, so setting the navigator key alone keeps the JS value and the
    // request header consistent.
    derived['navigator.userAgent'] = fingerprint.userAgent
  }
  if (fingerprint.deviceMemory !== null) {
    warn?.(
      `fingerprint.deviceMemory=${fingerprint.deviceMemory} ignored: the Camoufox engine has no ` +
        'navigator.deviceMemory property (Firefox does not implement it)',
    )
  }

  return {
    os: fingerprint.os,
    screen: fingerprint.screen ?? undefined,
    window: fingerprint.window ? [fingerprint.window.width, fingerprint.window.height] : undefined,
    webgl_config: fingerprint.webgl
      ? [fingerprint.webgl.vendor, fingerprint.webgl.renderer]
      : undefined,
    fonts: fingerprint.fonts ?? undefined,
    locale: fingerprint.locale ?? undefined,
    geoip: fingerprint.geoip,
    humanize: fingerprint.humanize,
    block_images: fingerprint.blockImages,
    block_webrtc: fingerprint.blockWebrtc,
    block_webgl: fingerprint.blockWebgl,
    disable_coop: fingerprint.disableCoop,
    config: { ...derived, ...fingerprint.config },
    proxy: toEngineProxy(proxy),
  }
}
