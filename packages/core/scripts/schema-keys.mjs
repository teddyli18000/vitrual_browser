#!/usr/bin/env node
/**
 * schema-keys.mjs — AN INSTRUMENT, NOT A CHECK. It asserts nothing and can never go red.
 *
 * WHAT IT IS FOR. It prints the CAMOU_CONFIG key list the engine will validate, produced by the
 * PRODUCT'S OWN mapper, so the next schema change costs seconds instead of a CI cycle. It earned its
 * place by answering in two runs what three CI cycles could not.
 *
 * WHY IT EXISTS, stated as the mistake it prevents. The test fixture's engine schema was derived three
 * ways and each was wrong, because each REIMPLEMENTED something the product already does:
 *
 *   1. enumerate the keys by hand        -> CI named the missing eight, one run at a time
 *   2. derive from the pin set alone     -> eight keys rejected by name
 *   3. flatten `identity.fingerprint`    -> WRONG NAMES: `screen.screenX` where the config has
 *                                           `window.screenX`, `screen.outerWidth` where it has
 *                                           `window.outerWidth`
 *
 * `identity.ts:196-200` records the rule and names the function: `fromBrowserforge()` is the mapper that
 * produces these keys, and it should be used "INSTEAD OF REIMPLEMENTING IT HERE". This script calls it,
 * so the key list it prints is the list the config actually carries.
 *
 * Usage: node packages/core/scripts/schema-keys.mjs
 * Prints: the derived key list with types, then the two sources separately.
 */
import process from 'node:process'

const fingerprints = await import('camoufox-js/dist/fingerprints.js').catch(error => {
  console.error(`could not load camoufox-js/dist/fingerprints.js: ${error.message}`)
  process.exit(2)
})
const { fromBrowserforge, generateFingerprint } = fingerprints

const typeOf = value =>
  Array.isArray(value)
    ? 'array'
    : typeof value === 'number'
      ? Number.isInteger(value)
        ? 'int'
        : 'double'
      : typeof value === 'boolean'
        ? 'bool'
        : typeof value === 'object' && value !== null
          ? 'dict'
          : 'str'

// `createIdentity` calls these two in this order (`identity.ts:161` and `:200`), so calling them the same
// way is what makes this instrument's output the same list the fixture must declare.
const raw = generateFingerprint(undefined, { operatingSystems: ['windows'] })
const mapped = fromBrowserforge(raw, '')

console.log('=== from `fromBrowserforge(generateFingerprint(...), \'\')` — the CAMOU_CONFIG keys ===')
const entries = Object.entries(mapped)
for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  { property: ${JSON.stringify(key)}, type: ${JSON.stringify(typeOf(value))} },`)
}
console.log(`  (${entries.length} keys)`)

console.log('')
console.log('=== for comparison: the product\'s pin set (`createIdentity(...).config`) ===')
const { createIdentity } = await import('../dist/identity.js')
const identity = await createIdentity({ os: 'windows', config: {} }, null)
const pinned = Object.entries(identity.config)
for (const [key, value] of pinned.sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  { property: ${JSON.stringify(key)}, type: ${JSON.stringify(typeOf(value))} },`)
}
console.log(`  (${pinned.length} keys)`)

console.log('')
console.log('A key the mapper emits and the pin set does not is a value the config carries anyway —')
console.log('declare both. A key that appears in NEITHER is one the fixture does not need.')
