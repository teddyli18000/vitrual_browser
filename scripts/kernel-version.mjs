#!/usr/bin/env node
/**
 * kernel-version.mjs — print the PINNED Camoufox engine version.
 *
 * Used by `.github/workflows/{ci,release}.yml` as the `actions/cache` key component for
 * `.cache/camoufox`, so the 550 MB engine is re-downloaded only when the pinned engine changes.
 *
 * This used to ask `camoufox-js` which release was newest, which made the cache key — and therefore
 * what CI tested — move whenever upstream published anything. That is exactly how engine 156 reached
 * a green build and then broke launching: it removed every `canvas:*` config key, so a profile's
 * canvas hash changed between launches. The version is now pinned in
 * `packages/shared/src/constants.ts`, read through `scripts/engine-version.mjs`, and this script
 * needs neither the network nor a GitHub token. Determinism is the point: the same commit always
 * means the same engine.
 *
 * Contract:
 *   stdout — exactly one line: the engine version (e.g. `152.0.4-beta.31`).
 *   stderr — diagnostics.
 *   exit 1 when the pinned version cannot be read.
 *
 * Usage:
 *   node scripts/kernel-version.mjs
 */
import process from 'node:process'
import { ENGINE_VERSION } from './engine-version.mjs'

if (typeof ENGINE_VERSION !== 'string' || ENGINE_VERSION === '') {
  console.error('[kernel-version] the pinned engine version is empty')
  process.exit(1)
}

console.error(`[kernel-version] pinned engine: ${ENGINE_VERSION}`)
console.log(ENGINE_VERSION)
