export const PRODUCT_NAME = 'VFox'
export const PRODUCT_NAME_ZH = 'VFox 指纹浏览器'
export const PRODUCT_TAGLINE = 'Open-source, telemetry-free anti-detect browser'
export const APP_ID = 'io.github.vfox.desktop'
export const HOMEPAGE = 'https://github.com/teddyli18000/vitrual_browser'

/** Environment variables understood by the core service. */
export const ENV = {
  dataDir: 'VFOX_DATA_DIR',
  apiPort: 'VFOX_API_PORT',
  apiHost: 'VFOX_API_HOST',
  apiToken: 'VFOX_API_TOKEN',
  /** Consumed by camoufox-js to locate / install the engine. */
  kernelDir: 'CAMOUFOX_INSTALL_DIR',
  logLevel: 'VFOX_LOG_LEVEL',
} as const

export const DEFAULT_START_URL = 'about:blank'

/** Camoufox-js peer range; keep in sync with packages/core/package.json. */
export const SUPPORTED_PLAYWRIGHT_CORE = '<1.61.0'
