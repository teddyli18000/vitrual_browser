import { FingerprintSchema, ProfileSchema } from '@vfox/shared'
import { createIdentity } from '../dist/identity.js'
import { toServerOptions } from '../dist/launcher.js'

const camouConfig = options => {
  const joined = Object.entries(options.env)
    .filter(([k]) => k.startsWith('CAMOU_CONFIG_'))
    .map(([k, v]) => [Number(k.split('_').pop()), v])
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .join('')
  return JSON.parse(joined)
}
const generated = await createIdentity(FingerprintSchema.parse({ os: 'windows', geoip: false }), 'test')
console.log('pinned config keys:', Object.keys(generated.config).join(', '))
console.log('pinned webgl:', JSON.stringify(generated.webgl))
const profile = ProfileSchema.parse({
  id: 'stable', name: 'Stable',
  fingerprint: { geoip: false, config: generated.config, webgl: generated.webgl },
  identity: generated.identity, launch: {}, createdAt: 'x', updatedAt: 'x',
})
const first = camouConfig(await toServerOptions(profile, 'C:\\p\\userdata', () => {}))
const second = camouConfig(await toServerOptions(profile, 'C:\\p\\userdata', () => {}))
const keys = new Set([...Object.keys(first), ...Object.keys(second)])
const differing = [...keys].filter(k => JSON.stringify(first[k]) !== JSON.stringify(second[k]))
console.log('differing keys:', differing.length ? differing.join(', ') : '(none)')
for (const key of differing) {
  console.log(`  ${key}: ${JSON.stringify(first[key])} vs ${JSON.stringify(second[key])}`)
}
