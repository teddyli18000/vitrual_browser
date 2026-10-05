import { FingerprintSchema, type Profile, ProfileSchema } from '@vfox/shared'
import { describe, expect, it } from 'vitest'
import {
  comfortableWindow,
  createIdentity,
  identityInputs,
  identityIsCurrent,
} from '../src/identity.js'

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
      identityInputs(
        FingerprintSchema.parse({
          screen: { minWidth: 1000, maxWidth: 1000, minHeight: 700, maxHeight: 700 },
        }),
      ),
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
    expect(identityIsCurrent(profile({ identity: { ...identity, engine: null } }), '152.0.4')).toBe(
      true,
    )
  })
})

describe('comfortable window sizing', () => {
  /**
   * The five work areas the policy was decided against, including one larger than the old absolute
   * ceiling and one smaller than the floor. The assertions are PROPERTIES, not the pixel values above:
   * a test that pins 1190x728 is the same mistake as the absolute clamp, and it fails the moment
   * somebody runs it on a different monitor.
   */
  const WORK_AREAS = [
    { width: 1920, height: 1040 },
    { width: 2560, height: 1400 },
    { width: 3840, height: 2080 },
    { width: 5120, height: 2880 },
    { width: 1366, height: 728 },
  ]

  it('stays proportional at every resolution, between the floor and 90% of the work area', () => {
    for (const workArea of WORK_AREAS) {
      const where = `${workArea.width}x${workArea.height}`
      const box = comfortableWindow(workArea)
      const floorWidth = Math.min(Math.round(workArea.width * 0.62), Math.min(1000, workArea.width))
      const floorHeight = Math.min(
        Math.round(workArea.height * 0.7),
        Math.min(640, workArea.height),
      )

      // At least the target, or the floor when the screen cannot fit the target.
      expect(box.width, where).toBeGreaterThanOrEqual(floorWidth)
      expect(box.height, where).toBeGreaterThanOrEqual(floorHeight)
      // Never more than 90% of the work area, and never larger than it: the ceiling is a fraction, so
      // "not full-screen" holds on a 5120-wide display as well as on a 1366-wide one.
      expect(box.width, where).toBeLessThanOrEqual(Math.round(workArea.width * 0.9))
      expect(box.height, where).toBeLessThanOrEqual(Math.round(workArea.height * 0.9))
      expect(box.width, where).toBeLessThanOrEqual(workArea.width)
      expect(box.height, where).toBeLessThanOrEqual(workArea.height)
      // Above the floor the ratio is constant, which is what "feels the same at every resolution" means.
      if (workArea.width * 0.62 >= 1000) {
        expect(box.width, where).toBe(Math.round(workArea.width * 0.62))
      }
      if (workArea.height * 0.7 >= 640) {
        expect(box.height, where).toBe(Math.round(workArea.height * 0.7))
      }
    }
  })

  it('centres the window without pushing it off the screen', () => {
    for (const workArea of WORK_AREAS) {
      const box = comfortableWindow(workArea)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(workArea.width)
      expect(box.y + box.height).toBeLessThanOrEqual(workArea.height)
    }
  })
})

describe('the work area from the caller', () => {
  const screenOf = async (workArea?: { width: number; height: number }) => {
    const created = await createIdentity(
      FingerprintSchema.parse({ os: 'windows', geoip: false }),
      '152.0.4',
      new Set(),
      workArea,
    )
    return created.identity.fingerprint.screen as Record<string, unknown>
  }

  it('sizes the window to the real work area a caller supplies', async () => {
    // A CI-sized runner. Without this input the window is sized from the display the fingerprint
    // claims, which is how a 1616x916 window landed on a 1600x900 available area.
    const screen = await screenOf({ width: 1024, height: 720 })

    expect(Number(screen.outerWidth)).toBeLessThanOrEqual(1024)
    expect(Number(screen.outerHeight)).toBeLessThanOrEqual(720)
  })

  it('falls back to the claimed display when the caller cannot see the real one', async () => {
    // The CLI and the server: identical to the behaviour before the field existed.
    const screen = await screenOf()

    expect(Number(screen.outerWidth)).toBeLessThanOrEqual(Number(screen.width))
    expect(Number(screen.outerHeight)).toBeLessThanOrEqual(Number(screen.height))
  })
})
