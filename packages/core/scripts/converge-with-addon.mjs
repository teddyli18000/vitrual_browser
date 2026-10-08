// The same convergence loop, but with a profile that HAS an addon - which is the only difference between
// the 237 passing cases and the four failing ones. If the loop stops converging here, then `addons` in the
// profile changes which `properties.json` camoufox-js reads, and the four failures are issue #103 rather
// than anything about the fixture's schema.
//
//     node packages/core/scripts/converge-probe.mjs --with-addon

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProfileSchema } from '@vfox/shared'
import { unknownPropertyKey } from '../dist/engine-config.js'
import { toServerOptions } from '../dist/launcher.js'

const withAddon = process.argv.includes('--with-addon')

const engineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-probe-engine-'))
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-probe-userdata-'))

// An addon's unit is an extracted directory containing manifest.json, and it lives in the profile's own
// directory - see AGENTS.md. A minimal one is enough: the launcher only checks that it exists.
const addonDir = path.join(userDataDir, 'vfox-addons', 'probe')
await fs.mkdir(addonDir, { recursive: true })
await fs.writeFile(
  path.join(addonDir, 'manifest.json'),
  JSON.stringify({ manifest_version: 2, name: 'probe', version: '1.0' }),
  'utf8',
)

const profile = ProfileSchema.parse({
  id: 'p1',
  name: 'p1',
  fingerprint: { geoip: false },
  launch: {},
  ...(withAddon
    ? { addons: [{ id: 'probe', name: 'probe', source: 'local', enabled: true }] }
    : {}),
  createdAt: 'x',
  updatedAt: 'x',
})

const write = keys =>
  fs.writeFile(
    path.join(engineDir, 'properties.json'),
    JSON.stringify([...keys].map(([property, type]) => ({ property, type }))),
    'utf8',
  )

await fs.writeFile(
  path.join(engineDir, 'version.json'),
  JSON.stringify({ version: '152.0.4', release: 'beta.30' }),
  'utf8',
)

console.log(`profile has addons: ${withAddon}`)

const config = async () => {
  const options = await toServerOptions(profile, userDataDir, () => {}, engineDir)
  const env = options.env ?? {}
  const chunks = Object.keys(env)
    .filter(key => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
  const joined = chunks.map(key => env[key]).join('')
  return joined ? JSON.parse(joined) : {}
}

const declared = new Map([['addons', 'array']])

for (let attempt = 1; attempt <= 64; attempt += 1) {
  await write(declared)
  try {
    const observed = await config()
    console.log(
      `\nCONVERGED after ${attempt} attempt(s); ${Object.keys(observed).length} key(s) in the config`,
    )
    console.log(`addons in the observed config: ${JSON.stringify(observed.addons ?? null)}`)
    process.exit(0)
  } catch (error) {
    const message = String(error?.message ?? error)
    const unknownKey = unknownPropertyKey(error)
    const listed = /even after dropping them:\s*(.+)$/m.exec(message)?.[1]
    const wrongType = /Invalid type for property (\S+)\. Expected \w+, got (\w+)/.exec(message)
    console.log(
      `attempt ${String(attempt).padStart(2)} | declared ${declared.size} | ${error?.name} | ${message.slice(0, 80)}`,
    )
    if (unknownKey && !declared.has(unknownKey)) {
      declared.set(unknownKey, 'dict')
      continue
    }
    if (listed) {
      let added = 0
      for (const key of listed
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)) {
        if (!declared.has(key)) {
          declared.set(key, 'dict')
          added += 1
        }
      }
      if (added > 0) continue
    }
    const TYPE_ACCEPTING = {
      number: 'double',
      string: 'str',
      boolean: 'bool',
      object: 'dict',
    }
    const wrongTypeKey = wrongType?.[1]
    const wrongTypeGot = wrongType?.[2]
    let wrongTypeValue = wrongTypeGot ? TYPE_ACCEPTING[wrongTypeGot] : undefined
    if (wrongTypeGot === 'object' && wrongTypeKey && declared.get(wrongTypeKey) === 'dict') {
      wrongTypeValue = 'array'
    }
    if (wrongTypeKey && wrongTypeValue && declared.get(wrongTypeKey) !== wrongTypeValue) {
      declared.set(wrongTypeKey, wrongTypeValue)
      continue
    }
    console.log('\nTHE LOOP THROWS HERE - and `addons` is declared in the file it just wrote.')
    console.log(String(error?.stack ?? error).slice(0, 400))
    process.exit(1)
  }
}

console.log('\nDID NOT CONVERGE in 64 attempts')
process.exit(1)
