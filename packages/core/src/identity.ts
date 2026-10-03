/**
 * Stable profile identity.
 *
 * The engine's fingerprint generator is **not reproducible across launches**: camoufox-js calls
 * browserforge's `getFingerprint()` on every launch when no fingerprint is supplied, and upstream
 * Camoufox's ROADMAP still lists "the same seed gives the same device, including its canvas and
 * audio output" as unfinished. A profile that lets the engine roll its own device is therefore a
 * different machine every time it is opened.
 *
 * So the identity is generated exactly once — at profile creation — stored on the profile, and
 * passed back verbatim as the engine's `fingerprint` option on every launch.
 *
 * The browserforge fingerprint alone is NOT enough. `camoufox-js` also re-rolls, on every launch:
 *   - six CAMOU_CONFIG keys, independently of the fingerprint (`dist/utils.js:424-433` seeds
 *     `fonts:spacing_seed`/`audio:seed`/`canvas:seed` and `window.history.length`; `:531-534` sets
 *     `canvas:aaOffset`/`canvas:aaCapOffset`). These are pinned in the profile's raw config escape
 *     hatch, because camoufox-js only sets them when the caller has not (`setInto`/`mergeInto`).
 *   - the WebGL sample: `sampleWebGL(os)` picks a row with `Math.random()` (`webgl/sample.js:62-75`),
 *     so the reported renderer, its parameters and its extension list drift between launches. A pair
 *     passed as `webgl_config` is returned deterministically instead (`sample.js:47-56`), so the
 *     chosen pair is pinned in `fingerprint.webgl`.
 */

import type { FingerprintConfig, FingerprintIdentity, Profile, WebglPair } from '@vfox/shared'

/** CAMOU_CONFIG keys the engine would otherwise randomise per launch. */
const PER_LAUNCH_RANDOM_KEYS = [
  'canvas:aaOffset',
  'canvas:aaCapOffset',
  'canvas:seed',
  'audio:seed',
  'fonts:spacing_seed',
  'window.history.length',
  'window.screenY',
] as const

/** Our OS names are the product's; the WebGL database is keyed by the engine's. */
const ENGINE_OS = { windows: 'win', macos: 'mac', linux: 'lin' } as const

export interface CreatedIdentity {
  identity: FingerprintIdentity
  /** Config keys to pin so the engine cannot re-roll them; merged into `fingerprint.config`. */
  config: Record<string, unknown>
  /** The WebGL pair to pin in `fingerprint.webgl`; `undefined` when the profile already has one. */
  webgl: WebglPair | undefined
}

/**
 * The fingerprint fields that decide what browserforge generates. Everything else in
 * `FingerprintConfig` is an engine option or a CAMOU_CONFIG value and does not affect the device
 * the identity describes, so editing it must not re-roll the identity.
 */
export function identityInputs(fingerprint: FingerprintConfig): string {
  return JSON.stringify({
    os: fingerprint.os,
    screen: fingerprint.screen,
    window: fingerprint.window,
  })
}

/** Generate a profile's device identity. Pure computation — no browser and no engine needed. */
export async function createIdentity(
  fingerprint: FingerprintConfig,
  engine: string | null,
): Promise<CreatedIdentity> {
  const { fromBrowserforge, generateFingerprint } = await import('camoufox-js/dist/fingerprints.js')

  // Mirrors what `launchOptions()` does when it is not given a fingerprint (dist/utils.js:400-406):
  // same generator, same inputs, so a stored identity is exactly what a fresh launch would produce.
  const generated = generateFingerprint(
    fingerprint.window ? [fingerprint.window.width, fingerprint.window.height] : undefined,
    {
      screen: fingerprint.screen ?? undefined,
      operatingSystems: [fingerprint.os],
    },
  )

  // `fromBrowserforge()` is where the last per-launch random lives: `handleScreenXY` picks
  // `window.screenY` with `randrange` whenever the fingerprint's screenX is far from zero
  // (dist/fingerprints.js:31-54). Running the mapper once and pinning what it produced keeps the
  // rest of the mapping upstream's, instead of reimplementing it here.
  const mapped = fromBrowserforge(generated, '') as unknown as Record<string, unknown>

  return {
    identity: {
      version: 1,
      engine,
      generatedAt: new Date().toISOString(),
      fingerprint: { ...generated },
    },
    config: pinPerLaunchRandomness(fingerprint.config, mapped['window.screenY']),
    webgl: fingerprint.webgl ?? (await pinWebgl(fingerprint.os)),
  }
}

/**
 * Can the stored identity still be used?
 *
 * A different engine version may rewrite the user-agent version or invalidate parts of the
 * fingerprint, so it is re-rolled once — the alternative is a profile whose UA disagrees with the
 * engine it runs on. `engine === null` means the engine is not installed (or its version is
 * unknown), which is no reason to throw away a perfectly good identity.
 */
export function identityIsCurrent(profile: Profile, engine: string | null): boolean {
  const identity = profile.identity
  if (!identity) {
    return false
  }
  if (engine === null || identity.engine === null) {
    return true
  }
  return identity.engine === engine
}

/** Stable values for the per-launch random keys; anything the user already set is left alone. */
function pinPerLaunchRandomness(
  existing: Record<string, unknown>,
  screenY: unknown,
): Record<string, unknown> {
  const seed = () => Math.floor(Math.random() * 4_294_967_295) + 1
  const pinned: Record<string, unknown> = {}
  // Per key, not all-or-nothing: a profile that already pins one seed must still get the others.
  const pin = (key: (typeof PER_LAUNCH_RANDOM_KEYS)[number], value: unknown) => {
    if (!(key in existing)) {
      pinned[key] = value
    }
  }

  pin('canvas:aaOffset', Math.floor(Math.random() * 101) - 50)
  pin('canvas:aaCapOffset', true)
  pin('canvas:seed', seed())
  pin('audio:seed', seed())
  pin('fonts:spacing_seed', seed())
  pin('window.history.length', Math.floor(Math.random() * 5) + 1)
  if (typeof screenY === 'number') {
    pin('window.screenY', screenY)
  }

  return pinned
}

/** Choose the WebGL pair this profile will report forever. */
async function pinWebgl(os: FingerprintConfig['os']): Promise<WebglPair | undefined> {
  const { sampleWebGL } = await import('camoufox-js/dist/webgl/sample.js')
  // `sampleWebGL` is declared as returning `WebGLData`, but it actually resolves the parsed `data`
  // column of the chosen row — the CAMOU_CONFIG fragment (`webGl:vendor`, `webGl:renderer`,
  // `webGl:parameters`, …). Verified against camoufox-js 0.12.0 at runtime.
  const sample = (await sampleWebGL(ENGINE_OS[os])) as unknown as Record<string, unknown>
  const vendor = sample['webGl:vendor']
  const renderer = sample['webGl:renderer']
  if (typeof vendor !== 'string' || typeof renderer !== 'string') {
    return undefined
  }
  return { vendor, renderer }
}
