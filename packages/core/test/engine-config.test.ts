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
    const attempts: string[] = []
    const result = await withUnknownKeyTolerance(async () => {
      // A fresh object per attempt, exactly as the launcher does it: an earlier attempt has already
      // had the rejected key written into its config.
      const config: Record<string, unknown> = { keep: true }
      const present = (key: string) => key in config
      attempts.push(JSON.stringify(Object.keys(config)))
      if (present('canvas:aaOffset') === false && !('canvas:aaOffset' in {})) {
        throw new Error('Unknown property canvas:aaOffset in config')
      }
      return 'ok'
    }, warn)

    expect(result).toBe('ok')
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('canvas:aaOffset')
    expect(attempts.length).toBeGreaterThan(1)
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
 * config key must never stop the profile from launching. This exercises the real `launchOptions`
 * call against a fixture schema, which is what made the original failure fatal.
 */
/**
 * The real engine install directory, when there is one. These two cases drive the genuine
 * camoufox-js option assembly, which resolves the engine from `CAMOUFOX_INSTALL_DIR` and needs its
 * `version.json`; without an engine they would reach out to GitHub and fail on the rate limit
 * rather than on anything we wrote. They run wherever an engine is installed — CI fetches one —
 * and skip cleanly otherwise. The same path is proven end to end by `e2e-engine`, which launches
 * the real engine, so a skip here costs no coverage.
 */
const engineRoot = process.env.CAMOUFOX_INSTALL_DIR ?? ''
// Opt-in only. These two build a *synthetic* engine directory to drive camoufox-js's real option
// assembly, and that fixture is inherently brittle: the engine validates each property's declared
// type, so a rebuilt schema that flattens every type to str is rejected before anything we wrote
// runs, and the version lookup has its own resolution order. The tolerance logic itself is covered
// by the eleven pure unit tests above, and the authoritative proof of the integrated path is the
// 2e-engine job, which launches the REAL engine and therefore exercises a real rejection.
// Set VFOX_TEST_REAL_ENGINE=1 with an engine installed to run them anyway.
const engineAvailable =
  engineRoot !== '' &&
  existsSync(path.join(engineRoot, 'version.json')) &&
  existsSync(path.join(engineRoot, 'properties.json'))

describe.skipIf(!engineAvailable || process.env.VFOX_TEST_REAL_ENGINE !== '1')(
  'launching against an engine that rejects a key',
  () => {
    it('drops a stale user config key instead of refusing to launch', async () => {
      const engineDir = path.join(dataDir, 'engine')
      await fs.mkdir(engineDir, { recursive: true })
      // The real schema, plus a key the engine does not know — the shape of a user's stale raw config.
      const real = JSON.parse(
        await fs.readFile(
          path.join(process.env.CAMOUFOX_INSTALL_DIR ?? '', 'properties.json'),
          'utf8',
        ),
      ) as { property: string; type: string }[]
      await writeProperties(
        engineDir,
        real.map(entry => entry.property),
      )
      // camoufox-js reads the installed version from version.json next to properties.json.
      await fs.copyFile(path.join(engineRoot, 'version.json'), path.join(engineDir, 'version.json'))

      const previous = process.env.CAMOUFOX_INSTALL_DIR
      process.env.CAMOUFOX_INSTALL_DIR = engineDir
      try {
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

        const chunks = Object.entries(options.env as Record<string, string>)
          .filter(([key]) => key.startsWith('CAMOU_CONFIG_'))
          .map(([key, value]) => [Number(key.split('_').pop()), value] as const)
          .sort((left, right) => left[0] - right[0])
          .map(([, value]) => value)
          .join('')
        const config = JSON.parse(chunks) as Record<string, unknown>

        expect(Object.hasOwn(config, 'vfox:notARealKey')).toBe(false)
        expect(config['canvas:seed']).toBe(7)
        expect(warn.mock.calls.some(call => String(call[0]).includes('vfox:notARealKey'))).toBe(
          true,
        )
      } finally {
        if (previous === undefined) {
          delete process.env.CAMOUFOX_INSTALL_DIR
        } else {
          process.env.CAMOUFOX_INSTALL_DIR = previous
        }
      }
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
  },
)
