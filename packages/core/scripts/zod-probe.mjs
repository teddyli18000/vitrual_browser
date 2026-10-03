import { FingerprintSchema, ProfileCreateSchema, ProfileUpdateSchema } from '@vfox/shared'

console.log('partial parse of {hardwareConcurrency:4}:')
console.log(JSON.stringify(ProfileUpdateSchema.parse({ fingerprint: { hardwareConcurrency: 4 } })))
console.log(
  'fingerprint partial parse:',
  JSON.stringify(FingerprintSchema.partial().parse({ hardwareConcurrency: 4 })),
)
console.log(
  'create parse:',
  JSON.stringify(ProfileCreateSchema.parse({ name: 'x', fingerprint: { os: 'macos' } })),
)
