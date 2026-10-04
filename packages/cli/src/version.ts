/**
 * CLI version, read from a `package.json` found by walking up from this module.
 *
 * Both `src/` and `dist/` sit one level below the manifest, so `../package.json` is the normal case.
 * The walk exists because the same helper in `packages/server` broke in the packaged app when a
 * fixed depth was assumed: `import.meta.url` becomes the **bundle's** path there, so the manifest is
 * one level further up than the source tree suggests, the read threw, and the catch returned a
 * literal that looked like a real release. A version a user can read must either be true or look
 * wrong; it must not look plausible.
 *
 * The fallback is therefore `0.0.0-unknown` rather than a release-looking number.
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
