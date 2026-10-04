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

/**
 * The Camoufox engine version VFox is built and tested against. **Pinned deliberately.**
 *
 * The engine is not an implementation detail of a fingerprint browser — it *is* the fingerprint.
 * `156.0.1-beta.34` removed every `canvas:*` config key (and `fonts:spacing_seed`) that
 * `152.0.4-beta.31` accepted: the engine's own `properties.json` lists 82 configurable properties
 * and not one of them is canvas. The consequence is not cosmetic — a profile's canvas hash changed
 * between two launches of the same stored identity, which is exactly the correlation signal this
 * product exists to prevent, and it was caught by the relaunch assertion in the CI smoke test.
 *
 * So "newest" is not "best" here: canvas spoofing is a capability we depend on, and an engine that
 * drops it is a regression for our users rather than an upgrade. We move this pin deliberately, and
 * only after the smoke test proves identity stability on the new engine.
 *
 * `scripts/engine-version.mjs` reads this value straight out of this file, so the CI fetch, the
 * Actions cache key and the in-app installer cannot disagree. There is exactly one place to bump.
 */
export const ENGINE_VERSION = '152.0.4-beta.30'

/** Camoufox-js peer range; keep in sync with packages/core/package.json. */
export const SUPPORTED_PLAYWRIGHT_CORE = '<1.61.0'
