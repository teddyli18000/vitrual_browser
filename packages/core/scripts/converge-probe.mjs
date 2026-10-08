// Converge the engine fixture's schema locally, in seconds, and print every attempt.
//
// WHY THIS EXISTS. The launcher-wiring test needs a fixture engine whose `properties.json` accepts
// whatever the product puts in `CAMOU_CONFIG`. Deriving that key set five different ways all failed, so
// the test converges it by ASKING the validator and learning from its named errors. When that loop
// stalled, the test could only report "did not converge in 64 attempts (1 key(s) declared)" - two numbers
// that took eight CI cycles to obtain and still did not say WHICH shape was firing or WHAT the validator
// objected to. This reproduces the loop line for line over the built `dist/` and prints every error, so
// the answer arrives in seconds.
//
// IT ASSERTS NOTHING. It is an instrument, like `schema-keys.mjs`: the verdict belongs to the test, and
// the two numbers worth reading are the attempt count and the declared count. On the commit that fixed
// shape 3 it printed:
//
//     CONVERGED after 35 attempt(s); 31 key(s) in the config
//     declared 34: addons, screen.availLeft, window.screenX, ...
//
// which is the config's real size - 34 keys learned, 31 reaching CAMOU_CONFIG - measured rather than
// inferred. Keep the loop here in step with the one in `test/addons.test.ts`; if they diverge, this stops
// being evidence about the test.
//
//     node packages/core/scripts/converge-probe.mjs      (after pnpm --filter @vfox/core build)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProfileSchema } from '@vfox/shared'
import { unknownPropertyKey } from '../dist/engine-config.js'
import { toServerOptions } from '../dist/launcher.js'

const engineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-probe-engine-'))
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-probe-userdata-'))

const profile = ProfileSchema.parse({
  id: 'p1',
  name: 'p1',
  fingerprint: { geoip: false },
  launch: {},
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

const config = async () => {
  const options = await toServerOptions(profile, userDataDir, () => {}, engineDir)
  const env = options.env ?? {}
  const chunks = Object.keys(env)
    .filter(key => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
  const joined = chunks.map(key => env[key]).join('')
  return joined ? JSON.parse(joined) : {}
}

// The fixture the TEST builds: `addons` first, because the engine's own properties.json declares it.
const declared = new Map([['addons', 'array']])

for (let attempt = 1; attempt <= 64; attempt += 1) {
  await write(declared)
  try {
    const observed = await config()
    console.log(
      `\nCONVERGED after ${attempt} attempt(s); ${Object.keys(observed).length} key(s) in the config`,
    )
    console.log(`declared ${declared.size}: ${[...declared.keys()].join(', ')}`)
    process.exit(0)
  } catch (error) {
    const message = String(error?.message ?? error)
    const unknownKey = unknownPropertyKey(error)
    const listed = /even after dropping them:\s*(.+)$/m.exec(message)?.[1]
    const wrongType = /Invalid type for property (\S+)\. Expected \w+, got (\w+)/.exec(message)

    let shape = 'none -> would THROW'
    if (unknownKey && !declared.has(unknownKey)) shape = `1 (new key "${unknownKey}")`
    else if (listed) shape = `2 (list "${listed.slice(0, 60)}")`
    else if (wrongType) shape = `3 ("${wrongType[1]}" -> ${wrongType[2]})`
    else if (unknownKey) shape = `1 blocked by the guard ("${unknownKey}" already declared)`

    console.log(
      `attempt ${String(attempt).padStart(2)} | declared ${declared.size} | ${error?.name} | ${message.slice(0, 88)}`,
    )
    console.log(`            shape: ${shape}`)

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
    const TYPE_ACCEPTING = { number: 'double', string: 'str', boolean: 'bool', object: 'dict' }
    const wrongTypeKey = wrongType?.[1]
    const wrongTypeGot = wrongType?.[2]
    let wrongTypeValue = wrongTypeGot ? TYPE_ACCEPTING[wrongTypeGot] : undefined
    if (wrongTypeGot === 'object' && declared.get(wrongTypeKey) === 'dict') wrongTypeValue = 'array'
    if (wrongTypeKey && wrongTypeValue && declared.get(wrongTypeKey) !== wrongTypeValue) {
      declared.set(wrongTypeKey, wrongTypeValue)
      continue
    }
    console.log('\nTHE LOOP THROWS HERE. This is the error the test reports, and the one to fix.')
    console.log(String(error?.stack ?? error).slice(0, 600))
    process.exit(1)
  }
}

console.log('\nDID NOT CONVERGE in 64 attempts')
process.exit(1)
