/**
 * Guards the fingerprint form against offering fields the engine cannot honour.
 *
 * The owner's complaint that started this: the dialog showed 设备内存 with a warning underneath
 * telling you not to use it. A control that cannot work is worse than no control — it invites a
 * mistake and then punishes it. The authoritative list of what the engine accepts is its own
 * `properties.json`, which `packages/core/src/engine-config.ts` already parses (`acceptedKeys`).
 *
 * Three assertions:
 *  1. Every field the form binds resolves to a CAMOU_CONFIG key the installed engine accepts, so an
 *     engine upgrade that drops a key fails here instead of at launch.
 *  2. No removed field is bound in the dialog again — the specific regression this check exists for.
 *  3. Every field listed below is still actually bound, so the table cannot rot into fiction.
 *
 * Skips with a clear message when the engine is not installed (a CI job that never ran
 * `kernel:fetch` must not fail on this), and never silently passes a field it could not check.
 *
 *   node scripts/check-fingerprint-fields.mjs
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const dialogPath = join(appRoot, 'src', 'renderer', 'src', 'components', 'ProfileDialog.vue')

/**
 * Every fingerprint-related field the form binds (`v-model="draft.<name>"`), and what it becomes in
 * the engine. `keys` are CAMOU_CONFIG property names, checked against `properties.json`. `prefs` are
 * Firefox user preferences, which camoufox-js sets directly (`dist/utils.js`) and which therefore
 * have no entry in that file — the browser honours them, not the config schema.
 */
const FIELDS = {
  os: { note: 'launch option `os` — selects the OS profile, no CAMOU_CONFIG key' },
  'screen.minWidth': { keys: ['screen.width'] },
  'screen.maxWidth': { keys: ['screen.width'] },
  'screen.minHeight': { keys: ['screen.height'] },
  'screen.maxHeight': { keys: ['screen.height'] },
  'window.width': { keys: ['window.outerWidth', 'window.innerWidth'] },
  'window.height': { keys: ['window.outerHeight', 'window.innerHeight'] },
  'webgl.vendor': { keys: ['webGl:vendor'] },
  'webgl.renderer': { keys: ['webGl:renderer'] },
  fontsText: { keys: ['fonts'] },
  locale: { keys: ['locale:language', 'locale:region', 'locale:all'] },
  hardwareConcurrency: { keys: ['navigator.hardwareConcurrency'] },
  userAgent: { keys: ['navigator.userAgent'] },
  geoip: { keys: ['geolocation:latitude', 'geolocation:longitude', 'timezone', 'webrtc:ipv4'] },
  humanize: { keys: ['humanize'] },
  blockImages: { prefs: ['permissions.default.image'] },
  blockWebrtc: { prefs: ['media.peerconnection.enabled'] },
  blockWebgl: { prefs: ['webgl.disabled'] },
  disableCoop: { prefs: ['browser.tabs.remote.useCrossOriginOpenerPolicy'] },
  configText: { note: 'raw escape hatch — filtered against this same set at launch' },
}

/**
 * Fields the shared schema still carries but the form deliberately does NOT bind, because the
 * engine cannot honour them. Listed explicitly so the reason survives and so the check below can
 * tell "known and removed" apart from "reintroduced by accident".
 */
const REMOVED = {
  deviceMemory: 'Firefox has no navigator.deviceMemory; camoufox-js throws UnknownProperty',
}

const engineDir = process.env.CAMOUFOX_INSTALL_DIR
const propertiesFile = engineDir ? join(engineDir, 'properties.json') : ''

if (!propertiesFile || !existsSync(propertiesFile)) {
  console.log(
    'engine not installed (CAMOUFOX_INSTALL_DIR/properties.json missing) — skipping.\n' +
      'Run `pnpm kernel:fetch` first to check the fingerprint fields against the real engine.',
  )
  process.exit(0)
}

const properties = JSON.parse(await readFile(propertiesFile, 'utf8'))
const accepted = new Set(
  properties
    .map(entry => entry?.property)
    .filter(property => typeof property === 'string' && property.length > 0),
)
console.log(`engine accepted properties : ${accepted.size}`)

const dialog = await readFile(dialogPath, 'utf8')
const bound = new Set([...dialog.matchAll(/v-model="draft\.([A-Za-z.]+)"/g)].map(m => m[1]))

const failures = []
let checked = 0

for (const [field, spec] of Object.entries(FIELDS)) {
  if (!bound.has(field)) {
    failures.push(
      `"${field}" is classified here but no longer bound in ProfileDialog.vue — update this table`,
    )
    continue
  }
  for (const key of spec.keys ?? []) {
    checked += 1
    if (!accepted.has(key)) {
      failures.push(
        `draft.${field} -> "${key}" is NOT accepted by this engine (${accepted.size} properties)`,
      )
    }
  }
  for (const pref of spec.prefs ?? []) {
    checked += 1
    console.log(`  pref  draft.${field.padEnd(22)} firefox ${pref}`)
  }
}

for (const [field, reason] of Object.entries(REMOVED)) {
  if (bound.has(field)) {
    failures.push(
      `draft.${field} is bound in ProfileDialog.vue again, but the engine cannot honour it: ${reason}`,
    )
  }
}

console.log(`fingerprint fields bound    : ${Object.keys(FIELDS).length}`)
console.log(`engine keys checked         : ${checked}`)
console.log(`removed fields asserted gone: ${Object.keys(REMOVED).join(', ')}`)

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log('\nOK — every fingerprint field the form binds is accepted by the engine.')
