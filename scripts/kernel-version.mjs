#!/usr/bin/env node
/**
 * kernel-version.mjs — print the Camoufox engine version that `camoufox-js` would install.
 *
 * Used by `.github/workflows/{ci,release}.yml` as the `actions/cache` key component for
 * `.cache/camoufox`, so the 550 MB engine is re-downloaded only when the engine itself
 * changes — not on every push, and not on every unrelated lockfile edit.
 *
 * The version is resolved by `camoufox-js`'s own fetcher (same code path `camoufox fetch`
 * uses), never re-implemented here: it is the latest non-prerelease `daijro/camoufox`
 * release inside the version range the installed `camoufox-js` supports, for this
 * platform/arch.
 *
 * `GITHUB_TOKEN` is honoured automatically by camoufox-js for api.github.com; CI passes
 * `${{ github.token }}` so the release lookup is authenticated instead of sharing the
 * unauthenticated 60 req/h per-IP budget.
 *
 * Contract:
 *   stdout — exactly one line: the engine version (e.g. `152.0.4-beta.31`).
 *   stderr — diagnostics.
 *   exit 1 with a clear reason when the version cannot be resolved.
 *
 * Usage:
 *   node scripts/kernel-version.mjs
 */
import process from 'node:process'

let CamoufoxFetcher
try {
  ;({ CamoufoxFetcher } = await import('camoufox-js/dist/pkgman.js'))
} catch (error) {
  console.error(
    `[kernel-version] cannot load camoufox-js (${error.message}). Run \`pnpm install\` first.`,
  )
  process.exit(1)
}

try {
  const fetcher = new CamoufoxFetcher()
  await fetcher.init()
  console.log(fetcher.verstr)
} catch (error) {
  console.error(
    `[kernel-version] could not resolve the Camoufox engine version: ${error.message}\n` +
      '  This is the same GitHub release lookup `camoufox fetch` performs, so the fetch ' +
      'would fail too.\n' +
      '  Check network access to api.github.com and set GITHUB_TOKEN to avoid the ' +
      'unauthenticated rate limit.',
  )
  process.exit(1)
}
