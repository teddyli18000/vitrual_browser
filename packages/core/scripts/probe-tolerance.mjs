/**
 * TEMPORARY: the P0 end-to-end proof. Runs the REAL `toServerOptions` against a simulated engine
 * 156 whose properties.json lacks the canvas keys, with a profile that carries our pinned identity
 * config — the exact shape that failed in CI. Deleted after the run.
 */
import { FingerprintSchema, ProfileSchema } from '@vfox/shared'
import { createIdentity } from '../dist/identity.js'
import { toServerOptions } from '../dist/launcher.js'

const warnings = []
const warn = message => warnings.push(message)

const generated = await createIdentity(
  FingerprintSchema.parse({ os: 'windows', geoip: false }),
  '156.0.1-beta.34',
)
const profile = ProfileSchema.parse({
  id: 'p0',
  name: 'p0',
  fingerprint: {
    geoip: false,
    config: generated.config,
    webgl: generated.webgl,
  },
  identity: generated.identity,
  launch: { headless: true },
  createdAt: 'x',
  updatedAt: 'x',
})

console.log(`engine dir: ${process.env.CAMOUFOX_INSTALL_DIR}`)
console.log(`pinned keys we would set: ${Object.keys(generated.config).join(', ')}`)

const options = await toServerOptions(profile, 'C:\\p\\userdata', warn)

const chunks = Object.entries(options.env)
  .filter(([key]) => key.startsWith('CAMOU_CONFIG_'))
  .map(([key, value]) => [Number(key.split('_').pop()), value])
  .sort((a, b) => a[0] - b[0])
  .map(([, value]) => value)
  .join('')
const config = JSON.parse(chunks)

console.log(`\nRESULT: toServerOptions succeeded`)
console.log(`  canvas:aaOffset in config?    ${Object.hasOwn(config, 'canvas:aaOffset')}`)
console.log(`  canvas:aaCapOffset in config? ${Object.hasOwn(config, 'canvas:aaCapOffset')}`)
console.log(`  canvas:seed in config?        ${Object.hasOwn(config, 'canvas:seed')}`)
console.log(`  audio:seed in config?         ${Object.hasOwn(config, 'audio:seed')}`)
console.log(`  window.screenY in config?     ${Object.hasOwn(config, 'window.screenY')}`)
console.log(`  prototype clean?              ${!('canvas:aaOffset' in {})}`)
console.log(`\nwarnings emitted (${warnings.length}):`)
for (const message of warnings) console.log(`  - ${message}`)
