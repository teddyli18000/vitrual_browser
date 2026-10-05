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
import { camoufoxModule } from './camoufox.js'

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
/** One row of the engine's WebGL table, with the weight it gives that GPU on this platform. */
interface WebglRow extends WebglPair {
  weight: number
}

/** The engine's WebGL table, read once per platform: it cannot change while we run. */
const rowsCache = new Map<string, WebglRow[]>()

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

/** Size a profile window to 55% x 62% of the work area, clamped and centred. */
const COMFORT = { widthFraction: 0.55, heightFraction: 0.62 } as const

/** The clamp that makes "never full-screen" true on a big monitor and "never tiny" true on a small one. */
const WINDOW_CLAMP = { minWidth: 1100, minHeight: 700, maxWidth: 1600, maxHeight: 1000 } as const

export interface WindowBox {
  width: number
  height: number
  x: number
  y: number
}

/**
 * Size and centre a profile window inside a work area.
 *
 * 55% x 62% of the work area, clamped to [1100x700, 1600x1000], centred, never maximised. On a
 * 1920x1040 desktop that is 1100x700 (clamped up from 1056x645); on 2560x1400 it is 1408x868. The
 * clamp is what keeps a window usable on a small screen without letting it fill a large one.
 *
 * When the work area is smaller than the floor, fitting inside it wins: a window wider than the
 * display is the exact defect this replaces, so the result is never larger than the area given, and
 * being slightly cramped is survivable where being full-screen is not. A 1024x720 runner therefore
 * gets 1024x700.
 */
export function comfortableWindow(workArea: { width: number; height: number }): WindowBox {
  const width = Math.min(
    Math.max(Math.round(workArea.width * COMFORT.widthFraction), WINDOW_CLAMP.minWidth),
    WINDOW_CLAMP.maxWidth,
    workArea.width,
  )
  const height = Math.min(
    Math.max(Math.round(workArea.height * COMFORT.heightFraction), WINDOW_CLAMP.minHeight),
    WINDOW_CLAMP.maxHeight,
    workArea.height,
  )
  return {
    width,
    height,
    x: Math.max(Math.round((workArea.width - width) / 2), 0),
    y: Math.max(Math.round((workArea.height - height) / 2), 0),
  }
}
/**
 * Pin a fingerprint's window to a comfortable box inside the screen it already claims.
 *
 * Only the outer size and the position are touched. `innerWidth`/`innerHeight` are deliberately left
 * as browserforge produced them - 0, which `_castToProperties` drops, so the browser reports its own
 * true viewport rather than a value derived from a chrome allowance. `availWidth`/`availHeight` are
 * raised to fit the window, so a profile never claims a window larger than its own available area.
 */
function applyComfortableWindow(screen: Record<string, unknown> | undefined): void {
  if (!screen) {
    return
  }
  const width = Number(screen.width)
  const height = Number(screen.height)
  if (!(width > 0) || !(height > 0)) {
    return
  }
  const box = comfortableWindow({ width, height })
  screen.outerWidth = box.width
  screen.outerHeight = box.height
  screen.screenX = box.x
  screen.screenY = box.y
  screen.availWidth = Math.max(Number(screen.availWidth) || 0, box.width)
  screen.availHeight = Math.max(Number(screen.availHeight) || 0, box.height)
  // Invariant, not adjustment: the box is already inside the display, and this makes that structural.
  screen.width = Math.max(width, box.width)
  screen.height = Math.max(height, box.height)
}
/** Generate a profile's device identity. Pure computation — no browser and no engine needed. */
export async function createIdentity(
  fingerprint: FingerprintConfig,
  engine: string | null,
  /** WebGL pairs other profiles already report, so a new profile does not repeat one. */
  takenWebgl: ReadonlySet<string> = new Set(),
): Promise<CreatedIdentity> {
  const { fromBrowserforge, generateFingerprint } = await import(
    camoufoxModule('dist/fingerprints.js')
  )

  // Mirrors what `launchOptions()` does when it is not given a fingerprint (dist/utils.js:400-406):
  // same generator, same inputs, so a stored identity is exactly what a fresh launch would produce.
  const generated = generateFingerprint(
    fingerprint.window ? [fingerprint.window.width, fingerprint.window.height] : undefined,
    {
      screen: fingerprint.screen ?? undefined,
      operatingSystems: [fingerprint.os],
    },
  )

  // The viewport in this fingerprint is `0`, and that is correct and harmless — do not "repair" it.
  //
  // `innerWidth: "window.innerWidth"` in the mapping table is never reached for a falsy value:
  // `_castToProperties` skips them (`if (!data) continue`, dist/fingerprints.js:13), so the key is
  // absent from CAMOU_CONFIG, `properties.json` has no default for it, and the engine overrides
  // nothing. Firefox reports its own true viewport — measured on the CI runner at 1770x1246 inside a
  // 1786x1311 window. Writing a non-zero value here would START it being mapped, replacing that
  // measured viewport with a guess derived from a chrome allowance that is not exactly right.
  //
  // If a geometry value ever does need correcting, correct it at launch, on a clone of the stored
  // fingerprint, and never by re-rolling the identity — a re-roll costs the user the device they have
  // been presenting, which is the one thing pinning exists to prevent.

  // The window a profile opens must fit the display it claims, and must not be the whole of it.
  //
  // Until now nothing consulted the display: browserforge drew a screen and an outer size
  // independently, which is how the CI runner ended up with a 1786x1311 window inside a 1024x720
  // work area - what Windows presents as full-screen, and a fingerprint tell on its own, since no
  // real user has a window larger than their screen. The engine sizes the real window to these values
  // (measured: os 1786x1311 == outer 1786x1311), so pinning a comfortable box here is what makes the
  // reported geometry equal to the window a person sees.
  //
  // The display it consults is the one the profile claims: `screen.width/height` is the draw the rest
  // of the fingerprint already describes, so the window can never exceed the screen it reports.
  // Sizing against the machine's REAL work area would be better still and is not possible from here -
  // see the note in the PR; it needs a caller that can see the display.
  applyComfortableWindow(generated.screen)
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
    webgl: fingerprint.webgl ?? (await pinWebgl(fingerprint.os, takenWebgl)),
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

/** A stable key for a WebGL pair, so callers can ask which pairs are already in use. */
export function webglPairKey(pair: { vendor: string; renderer: string }): string {
  return pair.vendor + '\u0000' + pair.renderer
}

/**
 * Every WebGL pair the engine offers for one platform, with the weight it gives it.
 *
 * The `win` / `mac` / `lin` columns are **floats, not flags** — they are the engine's own idea of how
 * common each GPU is (`mac: 0.819` for Apple, `win: 0.225` for the GTX 980). `sampleWebGL` draws from
 * them with `Math.random()`, which is why a third of the rows are effectively unreachable and one row
 * dominates. The weights are kept here deliberately: the distribution of GPUs across machines is
 * itself a fingerprint, and replacing it with a flat one would trade a link between two profiles for
 * an implausible population.
 */
async function webglRows(os: FingerprintConfig['os']): Promise<WebglRow[]> {
  const engineOs = ENGINE_OS[os]
  const cached = rowsCache.get(engineOs)
  if (cached) {
    return cached
  }

  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const resolved = camoufoxModule('dist/data-files/webgl_data.db')
  const path = resolved.startsWith('file:')
    ? fileURLToPath(resolved)
    : createRequire(import.meta.url).resolve(resolved)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db
      .prepare(
        'select vendor, renderer, ' +
          engineOs +
          ' as weight from webgl_fingerprints where ' +
          engineOs +
          ' > 0',
      )
      .all() as { vendor: unknown; renderer: unknown; weight: unknown }[]
    const parsed = rows
      .filter(
        row =>
          typeof row.vendor === 'string' &&
          typeof row.renderer === 'string' &&
          typeof row.weight === 'number' &&
          row.weight > 0,
      )
      .map(row => ({
        vendor: row.vendor as string,
        renderer: row.renderer as string,
        weight: row.weight as number,
      }))
    rowsCache.set(engineOs, parsed)
    return parsed
  } finally {
    db.close()
  }
}

/**
 * Choose the WebGL pair this profile will report forever, avoiding the pairs already handed out.
 *
 * The engine's own sampler is **biased by design** (see `webglRows`), and the bias is severe enough to
 * matter here: measured over 2000 draws against this build, only **15 of the 32 pairs are ever
 * produced**, the top three cover **81%**, and a single NVIDIA GTX 980 row is **45%**. Two profiles
 * drawn from it therefore report the same GPU most of the time, and a shared WebGL vendor and renderer
 * is among the first values a fingerprinting script reads. For an anti-detect browser that is not an
 * overlap, it is a link between accounts.
 *
 * Re-drawing does not fix it: with the popular pairs taken, what is left is rare, and a bounded number
 * of draws frequently fails to land on a survivor — which is exactly how a ten-profile run still ended
 * with a repeat.
 *
 * So the draw is still weighted, but only over the pairs nobody holds yet. Realism is preserved where
 * it can be, and the clustering disappears where it matters. The engine still supplies the row's own
 * parameters at launch: camoufox-js resolves `webgl_config: [vendor, renderer]` back to the full `data`
 * fragment, so only the pair is chosen here.
 *
 * When every pair is taken the pool widens back to the whole table, because at that point a repeat is
 * unavoidable and refusing to make a profile would be worse.
 */
async function pinWebgl(
  os: FingerprintConfig['os'],
  taken: ReadonlySet<string> = new Set(),
): Promise<WebglPair | undefined> {
  const rows = await webglRows(os)
  if (rows.length === 0) {
    return undefined
  }
  const free = rows.filter(row => !taken.has(webglPairKey(row)))
  const pool = free.length > 0 ? free : rows

  let roll = Math.random() * pool.reduce((sum, row) => sum + row.weight, 0)
  for (const row of pool) {
    roll -= row.weight
    if (roll <= 0) {
      return { vendor: row.vendor, renderer: row.renderer }
    }
  }
  const last = pool[pool.length - 1]
  return last ? { vendor: last.vendor, renderer: last.renderer } : undefined
}
