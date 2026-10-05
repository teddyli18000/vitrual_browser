/**
 * `humanize` must default to **on**.
 *
 * Why this is a test and not a comment: the default is invisible in every review that only reads a
 * diff, and it silently decides whether a new profile sends human-like input or raw synthetic
 * events. VFox exists so that a profile does not look automated, so defaulting to raw input is the
 * wrong default for this product — and a revert would look like a one-character diff.
 *
 * The owner hit this for real: a page refused their GitHub login with "Rapid taps or clicks" as the
 * first listed reason, on a profile that had `humanize: false`. That is a *plausible* contributor,
 * not a proven cause — the named cause on that page was their exit IP, a US datacenter ASN, which no
 * browser setting fixes. This test guards the default, not a diagnosis.
 *
 * Written as `.mjs` against `dist` to match the rest of the repository: Vite transpiles `.ts` with
 * esbuild, whose service needs a piped child process, and this machine's sandbox denies those. See
 * `run-vitest.mjs` for the launcher that makes these run locally as well as in CI.
 */

import { describe, expect, it } from 'vitest'

import { FingerprintSchema, ProfileCreateSchema, ProfileSchema } from '../dist/schemas.js'

describe('fingerprint.humanize', () => {
  // The regression guard. If someone flips the default back, this is the test that says so.
  it('defaults to true for anything that does not mention it', () => {
    expect(FingerprintSchema.parse({}).humanize).toBe(true)
  })
  // The negative case matters as much as the positive one: a key that is always on would mean the
  // user cannot turn it off, which is a different product decision than the one being made here.
  it('stays selectable — an explicit false survives parsing', () => {
    expect(FingerprintSchema.parse({ humanize: false }).humanize).toBe(false)
  })

  it('honours an explicit true', () => {
    expect(FingerprintSchema.parse({ humanize: true }).humanize).toBe(true)
  })

  it('does not turn other fields on as a side effect', () => {
    const parsed = FingerprintSchema.parse({})
    expect(parsed.geoip).toBe(true) // unchanged: it already defaulted to true
    expect(parsed.blockImages).toBe(false)
    expect(parsed.blockWebrtc).toBe(false)
    expect(parsed.blockWebgl).toBe(false)
    expect(parsed.disableCoop).toBe(false)
  })

  /**
   * The path a real profile takes. `store.createProfile` builds its record through `ProfileSchema`,
   * whose `fingerprint` is the full schema, so the default is applied there rather than only to a
   * bare `FingerprintSchema.parse({})` in isolation. If that ever stopped being true, the default
   * would exist on paper and not in the store.
   */
  it('reaches a stored profile created through ProfileSchema', () => {
    const profile = ProfileSchema.parse({
      id: 'p1',
      name: 'Default humanize',
      // `fingerprint` and `launch` are required *objects* whose fields all carry defaults, which is
      // exactly how `store.createProfile` calls it: `ProfileCreateSchema` fills the objects from the
      // caller's partial input, and `ProfileSchema` then fills every field inside them.
      fingerprint: {},
      launch: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(profile.fingerprint.humanize).toBe(true)
  })

  /**
   * `ProfileCreateSchema.fingerprint` is `FingerprintSchema.partial()`, and `.partial()` wraps each
   * default in an optional — so an omitted field is `undefined` here, not the default. The core
   * re-parses with the full schema (`ProfileSchema` / `FingerprintSchema.parse`), which is where the
   * default is actually applied. Asserted explicitly so nobody "fixes" the partial by hand.
   */
  it('leaves the field undefined on the partial create schema, by design', () => {
    expect(ProfileCreateSchema.parse({ name: 'x' }).fingerprint?.humanize).toBeUndefined()
  })
})
