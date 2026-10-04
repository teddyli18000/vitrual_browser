/**
 * Product version reported by `GET /api/v1/health`.
 *
 * The manifest is found by **walking up** from this module rather than assuming a fixed depth,
 * because the packaged application does not have the same layout as the source tree:
 *
 *   source tree   packages/server/dist/version.js  ->  ../package.json     exists
 *   packaged      app.asar/out/main/index.cjs      ->  ../package.json     does NOT exist
 *                                                  ->  ../../package.json  the app manifest
 *
 * The previous fixed `../package.json` therefore threw inside the packaged app and fell back to a
 * literal, which is why a 0.3.0 build reported `v0.1.0` in its own footer — and why bumping this
 * package's version changed nothing at all. The failure was silent: `readFileSync` threw, the catch
 * swallowed it, and a plausible-looking number was returned instead.
 *
 * The fallback is deliberately **not** a release-looking number. If the manifest cannot be found,
 * the honest answer is that the version is unknown; `0.0.0-unknown` reads as a problem, where
 * `0.1.0` read as a fact.
 */

import { readFileSync } from 'node:fs'

/** Where a `package.json` can sit relative to this module, nearest first. */
const MANIFEST_CANDIDATES = ['../package.json', '../../package.json', '../../../package.json']

const UNKNOWN_VERSION = '0.0.0-unknown'

let cached: string | undefined

function readVersion(): string | null {
  for (const relative of MANIFEST_CANDIDATES) {
    try {
      const raw = readFileSync(new URL(relative, import.meta.url), 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version
      }
    } catch {
      // Not there, or not readable: try the next level up.
    }
  }
  return null
}

export function packageVersion(): string {
  cached ??= readVersion() ?? UNKNOWN_VERSION
  return cached
}
