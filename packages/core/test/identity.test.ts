import { describe, expect, it } from 'vitest'
import { FingerprintSchema, ProfileSchema, type Profile } from '@vfox/shared'
import { createIdentity, identityInputs, identityIsCurrent } from '../src/identity.js'

function profile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({
    id: 'p1',
    name: 'p1',
    fingerprint: {},
    launch: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  })
}

describe('createIdentity', () => {
  it('generates a Firefox fingerprint and records the engine it was made for', async () => {
    const { identity } = await createIdentity(FingerprintSchema.parse({ os: 'macos' }), '152.0.4')

    expect(identity.version).toBe(1)
    expect(identity.engine).toBe('152.0.4')
    expect(identity.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const navigator = identity.fingerprint.navigator as { userAgent?: string }
    expect(navigator.userAgent).toContain('Firefox')
  })

  it('honours the screen and window constraints it is given', async () => {
    const { identity } = await createIdentity(
      FingerprintSchema.parse({
        os: 'windows',
        screen: { minWidth: 1920, maxWidth: 1920, minHeight: 1080, maxHeight: 1080 },
        window: { width: 1280, height: 720 },
      }),
      null,
    )

    const screen = identity.fingerprint.screen as { width: number; height: number }
    expect(screen.width).toBe(1920)
    expect(screen.height).toBe(1080)
  })

  it('pins every CAMOU_CONFIG key the engine would otherwise re-roll per launch', async () => {
    const { config } = await createIdentity(FingerprintSchema.parse({}), null)

    expect(Object.keys(config).sort()).toEqual([
      'audio:seed',
      'canvas:aaCapOffset',
      'canvas:aaOffset',
      'canvas:seed',
      'fonts:spacing_seed',
      'window.history.length',
      // `fromBrowserforge`'s handleScreenXY picks this with randrange on every launch.
      'window.screenY',
    ])
    expect(config['audio:seed']).toBeTypeOf('number')
    expect(config['canvas:aaOffset']).toBeTypeOf('number')
    expect(config['window.screenY']).toBeTypeOf('number')
    expect(config['window.history.length']).toBeGreaterThanOrEqual(1)
  })

  it('never overwrites a value the user already set', async () => {
    const fingerprint = FingerprintSchema.parse({
      config: { 'canvas:seed': 7, 'audio:seed': 9 },
    })
    const { config } = await createIdentity(fingerprint, null)

    expect(config['canvas:seed']).toBeUndefined()
    expect(config['audio:seed']).toBeUndefined()
    // Pinning is per key: one user-set seed must not stop the other four from being pinned.
    expect(config['fonts:spacing_seed']).toBeTypeOf('number')
    expect(config['canvas:aaOffset']).toBeTypeOf('number')
    expect(config['canvas:aaCapOffset']).toBe(true)
    expect(config['window.history.length']).toBeGreaterThanOrEqual(1)
  })

  it('pins a WebGL pair, because the engine samples one at random on every launch', async () => {
    const { webgl } = await createIdentity(FingerprintSchema.parse({ os: 'windows' }), null)

    expect(webgl?.vendor).toBeTypeOf('string')
    expect(webgl?.renderer).toBeTypeOf('string')
  })

  it('keeps the WebGL pair the user already chose', async () => {
    const chosen = { vendor: 'Google Inc.', renderer: 'Custom renderer' }
    const { webgl } = await createIdentity(FingerprintSchema.parse({ webgl: chosen }), null)

    expect(webgl).toEqual(chosen)
  })
})

describe('identityInputs', () => {
  it('changes with os, screen or window and with nothing else', () => {
    const base = FingerprintSchema.parse({})
    expect(identityInputs(FingerprintSchema.parse({ os: 'macos' }))).not.toBe(identityInputs(base))
    expect(
      identityInputs(FingerprintSchema.parse({ screen: { minWidth: 1000, maxWidth: 1000, minHeight: 700, maxHeight: 700 } })),
    ).not.toBe(identityInputs(base))
    expect(
      identityInputs(FingerprintSchema.parse({ window: { width: 800, height: 600 } })),
    ).not.toBe(identityInputs(base))

    // Engine options and CAMOU_CONFIG values are not part of the generated device.
    expect(identityInputs(FingerprintSchema.parse({ humanize: true, blockImages: true }))).toBe(
      identityInputs(base),
    )
    expect(
      identityInputs(FingerprintSchema.parse({ config: { 'navigator.maxTouchPoints': 5 } })),
    ).toBe(identityInputs(base))
  })
})

describe('identityIsCurrent', () => {
  const identity = {
    version: 1 as const,
    engine: '152.0.4',
    generatedAt: '2024-01-01T00:00:00.000Z',
    fingerprint: {},
  }

  it('is false without an identity', () => {
    expect(identityIsCurrent(profile(), '152.0.4')).toBe(false)
  })

  it('is true for the same engine and false for a different one', () => {
    expect(identityIsCurrent(profile({ identity }), '152.0.4')).toBe(true)
    expect(identityIsCurrent(profile({ identity }), '153.0.1')).toBe(false)
  })

  it('keeps an identity when the engine version is unknown', () => {
    expect(identityIsCurrent(profile({ identity }), null)).toBe(true)
    expect(
      identityIsCurrent(profile({ identity: { ...identity, engine: null } }), '152.0.4'),
    ).toBe(true)
  })
})
