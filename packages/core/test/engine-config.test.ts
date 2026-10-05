import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FingerprintSchema, ProfileSchema } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptedKeys,
  dropUnacceptedKeys,
  suppressUnknownKeys,
  unknownPropertyKey,
  withUnknownKeyTolerance,
} from '../src/engine-config.js'
import { toServerOptions } from '../src/launcher.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-engine-config-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** `properties.json` as the engine ships it: a JSON array of `{ property, type }` entries. */
async function writeProperties(dir: string, keys: string[] | unknown): Promise<void> {
  const payload = Array.isArray(keys) ? keys.map(property => ({ property, type: 'str' })) : keys
  await fs.writeFile(path.join(dir, 'properties.json'), JSON.stringify(payload), 'utf8')
}

describe('acceptedKeys', () => {
  it('reads the engine schema as an array of { property, type } entries', async () => {
    await writeProperties(dataDir, ['navigator.userAgent', 'canvas:seed'])
    const keys = await acceptedKeys(dataDir)

    expect(keys).toBeInstanceOf(Set)
    expect([...(keys ?? [])].sort()).toEqual(['canvas:seed', 'navigator.userAgent'])
  })

  it('returns null for anything it does not understand, so the caller launches as-is', async () => {
    await writeProperties(dataDir, { 'canvas:seed': 'uint' }) // a key→type map is NOT the schema
    expect(await acceptedKeys(dataDir)).toBeNull()

    const empty = path.join(dataDir, 'empty')
    await fs.mkdir(empty, { recursive: true })
    expect(await acceptedKeys(empty)).toBeNull()
  })

  it('caches per engine directory', async () => {
    await writeProperties(dataDir, ['canvas:seed'])
    const first = await acceptedKeys(dataDir)
    await writeProperties(dataDir, ['canvas:seed', 'canvas:aaOffset'])
    expect(await acceptedKeys(dataDir)).toBe(first)
  })
})

describe('dropUnacceptedKeys', () => {
  it('drops the keys the engine does not accept and names each one', () => {
    const warn = vi.fn()
    const { config, dropped } = dropUnacceptedKeys(
      { 'canvas:seed': 1, 'canvas:aaOffset': 2, 'window.screenY': 3 },
      new Set(['canvas:seed', 'window.screenY']),
      warn,
    )

    expect(config).toEqual({ 'canvas:seed': 1, 'window.screenY': 3 })
    expect(dropped).toEqual(['canvas:aaOffset'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('"canvas:aaOffset"')
  })

  it('changes nothing when the schema is unknown, and never warns then', () => {
    const warn = vi.fn()
    const input = { 'canvas:aaOffset': 2 }
    const { config, dropped } = dropUnacceptedKeys(input, null, warn)

    expect(config).toBe(input)
    expect(dropped).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('unknownPropertyKey', () => {
  it("parses camoufox-js's rejection message", () => {
    expect(unknownPropertyKey(new Error('Unknown property canvas:aaOffset in config'))).toBe(
      'canvas:aaOffset',
    )
  })

  it('returns null for anything else, so unrelated failures are rethrown unchanged', () => {
    expect(unknownPropertyKey(new Error('spawn EPERM'))).toBeNull()
    expect(unknownPropertyKey('not an error')).toBeNull()
  })
})

describe('suppressUnknownKeys', () => {
  it('hides the key from camoufox-js merges, from entries and from JSON, then cleans up', async () => {
    const seen = await suppressUnknownKeys(['canvas:aaOffset'], async () => {
      const target = { other: 1 }
      return {
        inTarget: 'canvas:aaOffset' in target,
        entries: JSON.stringify(Object.entries(target)),
        json: JSON.stringify(target),
      }
    })

    expect(seen.inTarget).toBe(true)
    expect(seen.entries).toBe('[["other",1]]')
    expect(seen.json).toBe('{"other":1}')
    // And it is gone afterwards, even though the call succeeded.
    expect('canvas:aaOffset' in {}).toBe(false)
  })

  it('cleans up after a throw too', async () => {
    await expect(
      suppressUnknownKeys(['canvas:aaOffset'], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect('canvas:aaOffset' in {}).toBe(false)
  })
})

describe('withUnknownKeyTolerance', () => {
  it('retries with each rejected key suppressed and reports every one', async () => {
    const warn = vi.fn()
    let attempts = 0
    const result = await withUnknownKeyTolerance(async () => {
      attempts += 1
      // Exactly the launcher's shape: a fresh config object per attempt, and the key camoufox-js
      // merges by itself. `in` sees the suppression, so the merge is skipped and validation passes.
      const config: Record<string, unknown> = { keep: true }
      if (!('canvas:aaOffset' in config)) {
        throw new Error('Unknown property canvas:aaOffset in config')
      }
      return 'ok'
    }, warn)

    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('canvas:aaOffset')
  })

  it('rethrows an unrelated error unchanged', async () => {
    await expect(
      withUnknownKeyTolerance(async () => {
        throw new Error('spawn EPERM')
      }),
    ).rejects.toThrow('spawn EPERM')
  })
})

/**
 * The regression that broke v0.1.0 for every user whose engine auto-updated: an engine that drops a
 * config key must never stop the profile from launching.
 *
 * These drive the real `launchOptions` assembly, so they need an installed engine — the same
 * prerequisite as every other test that touches camoufox-js — and skip cleanly without one.
 */
const engineRoot = process.env.CAMOUFOX_INSTALL_DIR ?? ''
const engineAvailable =
  engineRoot !== '' &&
  existsSync(path.join(engineRoot, 'version.json')) &&
  existsSync(path.join(engineRoot, 'properties.json'))

/** Reassemble the chunked CAMOU_CONFIG_<n> environment variables camoufox-js produces. */
function camouConfig(options: Record<string, unknown>): Record<string, unknown> {
  const env = options.env as Record<string, string>
  const joined = Object.entries(env)
    .filter(([key]) => key.startsWith('CAMOU_CONFIG_'))
    .map(([key, value]) => [Number(key.split('_').pop()), value] as const)
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value)
    .join('')
  return JSON.parse(joined) as Record<string, unknown>
}

describe.skipIf(!engineAvailable)('launching against an engine that rejects a key', () => {
  it('drops a stale user config key instead of refusing to launch', async () => {
    const warn = vi.fn()
    const profile = ProfileSchema.parse({
      id: 'stale',
      name: 'stale',
      fingerprint: { geoip: false, config: { 'vfox:notARealKey': 1, 'canvas:seed': 7 } },
      launch: {},
      createdAt: 'x',
      updatedAt: 'x',
    })

    const options = await toServerOptions(profile, 'C:\\p\\userdata', warn)

    const config = camouConfig(options)
    expect(Object.hasOwn(config, 'vfox:notARealKey')).toBe(false)
    expect(config['canvas:seed']).toBe(7)
    expect(warn.mock.calls.some(call => String(call[0]).includes('vfox:notARealKey'))).toBe(true)
  })

  it('still launches normally when every key is accepted', async () => {
    const profile = ProfileSchema.parse({
      id: 'fine',
      name: 'fine',
      fingerprint: FingerprintSchema.parse({ geoip: false }),
      launch: {},
      createdAt: 'x',
      updatedAt: 'x',
    })
    const warn = vi.fn()
    const options = await toServerOptions(profile, 'C:\\p\\userdata', warn)

    expect(options.executablePath).toBeTruthy()
    expect(warn).not.toHaveBeenCalled()
  })

  /**
   * What the 156 engine did to `canvas:aaOffset`. The fixture keeps the real `type` fields: a rebuilt
   * schema that flattened them all to `str` is rejected by camoufox-js's own type validation before
   * any of our code runs — a trap worth naming, because it makes the fixture look like a failure of
   * the code under test.
   */
  it('drops the pinned canvas keys when the engine schema omits them', async () => {
    const schema = JSON.parse(
      await fs.readFile(path.join(engineRoot, 'properties.json'), 'utf8'),
    ) as { property: string; type: string }[]
    expect(schema.some(entry => entry.property === 'canvas:aaOffset')).toBe(true)

    const fixtureDir = path.join(dataDir, 'engine-156')
    await fs.mkdir(fixtureDir, { recursive: true })
    await fs.writeFile(
      path.join(fixtureDir, 'properties.json'),
      JSON.stringify(
        schema.filter(entry => !['canvas:aaOffset', 'canvas:aaCapOffset'].includes(entry.property)),
      ),
      'utf8',
    )

    const warn = vi.fn()
    const { config, dropped } = dropUnacceptedKeys(
      { 'canvas:aaOffset': 7, 'canvas:aaCapOffset': true, 'canvas:seed': 7 },
      await acceptedKeys(fixtureDir),
      warn,
    )

    expect(dropped.sort()).toEqual(['canvas:aaCapOffset', 'canvas:aaOffset'])
    expect(config).toEqual({ 'canvas:seed': 7 })
    expect(String(warn.mock.calls[0]?.[0])).toContain('"canvas:aaOffset"')
  })
})
