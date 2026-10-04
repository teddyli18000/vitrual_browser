/**
 * Tolerance for config keys the installed engine does not accept.
 *
 * `camoufox-js` validates the whole CAMOU_CONFIG against the engine's own `properties.json` and
 * throws `UnknownProperty` for anything else — which turns an engine update into a total launch
 * failure. That is exactly what happened when the engine moved 152.0.4-beta.31 → 156.0.1-beta.34:
 * `canvas:aaOffset` disappeared from the engine's schema and every profile stopped launching.
 *
 * Two layers, because the unknown key can come from two places:
 *
 *  1. keys **we** set — the identity's pinned seeds and the user's raw `fingerprint.config` escape
 *     hatch. Those are filtered against the engine's own `properties.json` before the launch, and
 *     each dropped key is named in a warning. A dropped pin degrades identity stability, which is
 *     survivable; a refused launch is not.
 *  2. keys **camoufox-js merges by itself** — `canvas:aaOffset`, `canvas:aaCapOffset` and
 *     `window.history.length` are added unconditionally (`dist/utils.js:424-433`, `:531-534`), so no
 *     config we pass can prevent them. Those are handled by `suppressUnknownKeys`: the merge helper
 *     is `if (!(key in target)) target[key] = value`, and `in` walks the prototype chain, so a
 *     temporary non-enumerable property on `Object.prototype` makes camoufox-js skip the key while
 *     `Object.entries` (validation) and `JSON.stringify` (the CAMOU_CONFIG env vars the engine
 *     reads) never see it. It is removed again in a `finally`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** Per-engine-directory cache: the key set only changes when the engine does. */
const keyCache = new Map<string, Promise<Set<string> | null>>()

/**
 * The config keys the engine at `engineDir` accepts, or `null` when that cannot be determined.
 *
 * `properties.json` is a JSON array of `{ property, type }` entries; anything else means we do not
 * understand this engine's schema, and the caller launches as-is rather than refusing.
 */
export function acceptedKeys(engineDir: string): Promise<Set<string> | null> {
  const cached = keyCache.get(engineDir)
  if (cached) {
    return cached
  }
  const loaded = readAcceptedKeys(engineDir)
  keyCache.set(engineDir, loaded)
  return loaded
}

async function readAcceptedKeys(engineDir: string): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(path.join(engineDir, 'properties.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }
    const keys = new Set<string>()
    for (const entry of parsed) {
      const property = (entry as { property?: unknown } | null)?.property
      if (typeof property === 'string' && property.length > 0) {
        keys.add(property)
      }
    }
    return keys.size > 0 ? keys : null
  } catch {
    return null
  }
}

/** Drop the keys `accepted` does not contain, naming each one through `warn`. */
export function dropUnacceptedKeys(
  config: Record<string, unknown>,
  accepted: Set<string> | null,
  warn?: (message: string) => void,
): { config: Record<string, unknown>; dropped: string[] } {
  if (!accepted) {
    return { config, dropped: [] }
  }
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (accepted.has(key)) {
      kept[key] = value
    } else {
      dropped.push(key)
    }
  }
  if (dropped.length > 0) {
    warn?.(
      `the installed engine does not accept ${dropped.length} config key(s); dropping ` +
        `${dropped.map(key => `"${key}"`).join(', ')} — identity stability for those values is lost, ` +
        'but the profile can launch',
    )
  }
  return { config: kept, dropped }
}

/**
 * The key camoufox-js rejected, from its `Unknown property <key> in config` error, or `null` when
 * the error is something else entirely (which must be rethrown unchanged).
 */
export function unknownPropertyKey(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /Unknown property (?<key>\S+) in config/.exec(message)
  return match?.groups?.key ?? null
}

/**
 * Run `fn` with `keys` made invisible to camoufox-js's own config merges.
 *
 * See the header: this is the only way to stop `mergeInto` from adding a key the engine no longer
 * knows, and it is scoped to the call and undone in a `finally`.
 */
export async function suppressUnknownKeys<T>(
  keys: Iterable<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const installed: string[] = []
  for (const key of keys) {
    Object.defineProperty(Object.prototype, key, {
      value: 0,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    installed.push(key)
  }
  try {
    return await fn()
  } finally {
    for (const key of installed) {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
  }
}

/**
 * Call `launchOptions` and, when the engine rejects a key camoufox-js injected itself, retry with
 * that key suppressed. Bounded: a key that keeps being rejected after suppression ends the loop.
 *
 * `run` must build a **fresh** config object on every call. A rejected attempt has already written
 * the offending key into the object it was handed, as an own enumerable property; reusing that
 * object would carry the key past the suppression and fail identically on every retry. (Measured:
 * that is exactly how the first version of this function behaved.)
 */
export async function withUnknownKeyTolerance<T>(
  run: () => Promise<T>,
  warn?: (message: string) => void,
  maxAttempts = 8,
): Promise<T> {
  const suppressed = new Set<string>()
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await suppressUnknownKeys(suppressed, run)
    } catch (error) {
      const key = unknownPropertyKey(error)
      if (!key || suppressed.has(key)) {
        throw error
      }
      suppressed.add(key)
      warn?.(
        `the installed engine does not accept the config key "${key}"; dropping it so the profile ` +
          'can launch (that fingerprint value is no longer pinned)',
      )
    }
  }
  throw new Error(
    `the installed engine rejected ${suppressed.size} config key(s) even after dropping them: ` +
      [...suppressed].join(', '),
  )
}
