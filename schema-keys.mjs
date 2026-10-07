// The instrument this PR has been missing.
//
// Three CI cycles were spent learning one thing each about a derived schema, because the derivation lives
// inside a vitest file and vitest cannot run in this sandbox - vite spawns a child with a pipe and the
// sandbox forbids it. This calls the same two sources directly over the built `dist/` and prints the key
// names and types in seconds, which is what turns the next change from a CI cycle into a local answer.
//
// It is deliberately NOT a guard: it asserts nothing and can never go red. The guard is the vitest case in
// `addons.test.ts`. This is the instrument that tells you what to write there.

import { createIdentity } from './packages/core/dist/identity.js'

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

const generated = await createIdentity({ os: 'windows', config: {} }, null)

console.log('=== source 1: the pin set (`config`) ===')
const pinKeys = Object.keys(generated.config ?? {})
console.log(`  ${pinKeys.length} key(s): ${pinKeys.join(', ')}`)

console.log('')
console.log('=== source 2: the fingerprint (`identity.fingerprint`) ===')
const fingerprint = generated.identity?.fingerprint ?? {}
const flatten = (value, prefix = '') => {
  const out = []
  for (const [key, inner] of Object.entries(value ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      out.push(...flatten(inner, name))
    } else {
      out.push({ property: name, type: typeOf(inner) })
    }
  }
  return out
}
const flat = flatten(fingerprint)
console.log(`  ${Object.keys(fingerprint).length} top-level key(s), ${flat.length} flattened leaf/leaves`)
for (const entry of flat) {
  console.log(`    ${entry.property}  ->  ${entry.type}`)
}

console.log('')
console.log('=== the union the fixture would declare ===')
const union = new Map()
for (const key of pinKeys) union.set(key, typeOf(generated.config[key]))
for (const entry of flat) if (!union.has(entry.property)) union.set(entry.property, entry.type)
console.log(`  ${union.size} propert(ies):`)
for (const [property, type] of union) {
  console.log(`    { property: '${property}', type: '${type}' },`)
}

console.log('')
console.log('=== the eight keys CI named, and whether this covers them ===')
const named = [
  'window.screenX',
  'screen.width',
  'screen.height',
  'screen.availWidth',
  'screen.availHeight',
  'screen.availLeft',
  'window.outerWidth',
  'window.outerHeight',
]
for (const key of named) {
  const hit = union.has(key) ? union.get(key) : null
  console.log(`  ${hit ? 'COVERED' : 'MISSING'}  ${key}${hit ? ` (${hit})` : ''}`)
}
