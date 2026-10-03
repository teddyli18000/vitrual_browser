/**
 * CLI version, read from this package's own `package.json` at runtime (both `src/` and `dist/` sit
 * one level below it) so there is exactly one place to bump.
 */

import { readFileSync } from 'node:fs'

const FALLBACK_VERSION = '0.1.0'

let cached: string | undefined

export function packageVersion(): string {
  if (cached !== undefined) return cached
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cached =
      typeof parsed.version === 'string' && parsed.version.length > 0
        ? parsed.version
        : FALLBACK_VERSION
  } catch {
    cached = FALLBACK_VERSION
  }
  return cached
}
