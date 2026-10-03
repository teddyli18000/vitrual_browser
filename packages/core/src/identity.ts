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
 * The browserforge fingerprint alone is NOT enough: `camoufox-js` re-rolls six CAMOU_CONFIG keys on
 * every launch regardless of the fingerprint (`dist/utils.js:424-433` seeds
 * `fonts:spacing_seed`/`audio:seed`/`canvas:seed` and `window.history.length`, and `:531-534` sets
 * `canvas:aaOffset`/`canvas:aaCapOffset`). Those keys are pinned once, in the profile's raw config
 * escape hatch, because camoufox-js only sets them when the caller has not (`setInto`/`mergeInto`).
 * Without them the canvas hash and the audio output change on every launch.
 */

import type { FingerprintConfig, FingerprintIdentity, Profile } from '@vfox/shared'

/** CAMOU_CONFIG keys the engine would otherwise randomise per launch. */
const PER_LAUNCH_RANDOM_KEYS = [
  'canvas:aaOffset',
  'canvas:aaCapOffset',
  'canvas:seed',
  'audio:seed',
  'fonts:spacing_seed',
  'window.history.length',
] as const

export interface CreatedIdentity {
  identity: FingerprintIdentity
  /** Config keys to pin so the engine cannot re-roll them; merged into `fingerprint.config`. */
  config: Record<string, unknown>
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
  const { generateFingerprint } = await import('camoufox-js/dist/fingerprints.js')

  // Mirrors what `launchOptions()` does when it is not given a fingerprint (dist/utils.js:400-406):
  // same generator, same inputs, so a stored identity is exactly what a fresh launch would produce.
  const generated = generateFingerprint(
    fingerprint.window ? [fingerprint.window.width, fingerprint.window.height] : undefined,
    {
      screen: fingerprint.screen ?? undefined,
      operatingSystems: [fingerprint.os],
    },
  )

  return {
    identity: {
      version: 1,
      engine,
      generatedAt: new Date().toISOString(),
      fingerprint: { ...generated },
    },
    config: pinPerLaunchRandomness(fingerprint.config),
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
function pinPerLaunchRandomness(existing: Record<string, unknown>): Record<string, unknown> {
  const seed = () => Math.floor(Math.random() * 4_294_967_295) + 1
  const pinned: Record<string, unknown> = {}

  if (!PER_LAUNCH_RANDOM_KEYS.some(key => key in existing)) {
    pinned['canvas:aaOffset'] = Math.floor(Math.random() * 101) - 50
    pinned['canvas:aaCapOffset'] = true
    pinned['canvas:seed'] = seed()
    pinned['audio:seed'] = seed()
    pinned['fonts:spacing_seed'] = seed()
    pinned['window.history.length'] = Math.floor(Math.random() * 5) + 1
  }

  return pinned
}
