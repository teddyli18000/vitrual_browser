/**
 * Print the engine's own fingerprint-config surface, so a change in what it accepts is visible in
 * the CI log instead of only as a mysterious dropped pin.
 *
 * Written after engine 156.0.1-beta.34 stopped accepting `canvas:aaOffset`, which `identity.ts`
 * pinned for fingerprint stability. The tolerance path then dropped the pin and the smoke test
 * caught the consequence — a profile whose canvas hash changed between launches. This script is how
 * we find out what the replacement key is called, if there is one.
 *
 * Exit code is 0 even when a section is empty: this is a report, not a gate.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.env.CAMOUFOX_INSTALL_DIR
if (!dir) {
  console.error('[surface] CAMOUFOX_INSTALL_DIR is not set')
  process.exit(2)
}

const readJson = file => {
  try {
    return JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
  } catch (error) {
    console.error(`[surface] could not read ${file}: ${error.message}`)
    return null
  }
}

const version = readJson('version.json')
console.log(`[surface] engine ${version ? `${version.version}-${version.release}` : 'unknown'}`)
console.log(`[surface] install dir: ${dir}`)

const properties = readJson('properties.json')
if (!Array.isArray(properties)) {
  console.error('[surface] properties.json is not the expected array — nothing to report')
  process.exit(0)
}

const entries = properties.filter(
  entry => entry && typeof entry.property === 'string' && typeof entry.type === 'string',
)
console.log(`[surface] ${entries.length} configurable properties`)

const interesting = /^(canvas|audio|fonts|window|screen|navigator|webGl|webgl|voices|media)/i
const groups = new Map()
for (const { property, type } of entries) {
  if (!interesting.test(property)) continue
  const family = property.includes(':') ? property.slice(0, property.indexOf(':')) : property
  if (!groups.has(family)) groups.set(family, [])
  groups.get(family).push(`${property} (${type})`)
}

console.log('\n[surface] ----- fingerprint families this engine accepts -----')
for (const family of [...groups.keys()].sort()) {
  console.log(`\n[surface] ${family}:`)
  for (const item of groups.get(family).sort()) console.log(`[surface]   ${item}`)
}

// The specific question: what replaced canvas:aaOffset, if anything?
console.log('\n[surface] ----- keys containing "aa" or "seed" -----')
const suspects = entries
  .filter(entry => /aa|seed/i.test(entry.property))
  .map(entry => `${entry.property} (${entry.type})`)
console.log(suspects.length ? suspects.join('\n') : '(none)')

console.log('\n[surface] ----- END -----')
