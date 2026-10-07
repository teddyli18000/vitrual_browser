/**
 * The per-profile addon store, against real directories and real archives.
 *
 * The unit here is the one the engine actually consumes — an extracted directory containing
 * `manifest.json` — so everything below is genuine filesystem work, including the `.xpi`
 * extraction, the zip-slip refusal and the atomic swap. What it does **not** prove is that the
 * engine loads what we store: that needs a launch, which this sandbox cannot do (see the AGENTS.md
 * note). `verify-window.mjs` asserts exactly that in CI, on a real headed profile.
 *
 * The launcher half of this file asserts the option object handed to `firefox.launchServer()`, which
 * is where the three camoufox-js traps live: it mutates the `addons` array, it overwrites
 * `config.addons` unconditionally, and it only accepts absolute paths.
 */

import { existsSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProfileSchema } from '@vfox/shared'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADDON_STORE_DIR,
  addonDir,
  addonStoreDir,
  excludeDefaultAddons,
  installAddon,
  listAddons,
  listEngineAddons,
  pruneEngineAddons,
  removeAddon,
} from '../src/addons.js'
import { toServerOptions } from '../src/launcher.js'

let root: string
let userDataDir: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-addons-'))
  userDataDir = path.join(root, 'profiles', 'p1', 'userdata')
  await fs.mkdir(userDataDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** An extracted addon: the engine's unit. */
async function writeAddon(
  dir: string,
  manifest: Record<string, unknown> = {},
  files: Record<string, string> = {},
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 2,
        name: 'Test addon',
        version: '1.2.3',
        browser_specific_settings: { gecko: { id: 'test-addon@vfox.test' } },
        ...manifest,
      },
      null,
      2,
    ),
    'utf8',
  )
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return dir
}

function writeXpi(file: string, entries: Record<string, string>): string {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'))
  }
  zip.writeZip(file)
  return file
}

/**
 * A stored-zip writer, for the one archive `adm-zip` cannot produce.
 *
 * `adm-zip` normalises entry names on the way in — `../escaped.txt` comes back as `escaped.txt` — so
 * it cannot express the zip-slip case this file has to test. This writes the entry name verbatim.
 */
function rawZip(file: string, entries: Record<string, string>): string {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  const crc32 = (buffer: Buffer): number => {
    let c = -1
    for (const byte of buffer) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }

  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(file, Buffer.concat([...locals, centralBuffer, end]))
  return file
}

const MANIFEST = JSON.stringify({
  manifest_version: 2,
  name: 'Packed addon',
  version: '9.9.9',
  browser_specific_settings: { gecko: { id: 'packed@vfox.test' } },
})

/** A fake engine directory: only what the addon wiring reads. */
async function writeEngineAddon(key: string, id: string | null, name = key): Promise<string> {
  const engineDir = path.join(root, 'engine')
  const dir = path.join(engineDir, 'addons', key)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name,
      version: '1.0.0',
      ...(id === null ? {} : { browser_specific_settings: { gecko: { id } } }),
    }),
    'utf8',
  )
  return engineDir
}

describe('the addon store', () => {
  it('installs an extracted directory and reads it back', async () => {
    const source = await writeAddon(path.join(root, 'src', 'my-addon'), {}, { 'lib/a.js': 'x' })

    const installed = await installAddon(userDataDir, source)

    expect(installed).toMatchObject({
      slug: 'test-addon@vfox.test',
      id: 'test-addon@vfox.test',
      name: 'Test addon',
      version: '1.2.3',
      source: 'vfox',
      files: 2,
    })
    expect(installed.bytes).toBeGreaterThan(0)
    expect(
      await fs.readFile(path.join(addonDir(userDataDir, installed.slug), 'lib/a.js'), 'utf8'),
    ).toBe('x')

    const listed = await listAddons(userDataDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ slug: 'test-addon@vfox.test', version: '1.2.3' })
  })

  it('installs an .xpi by extracting it, because the engine only loads directories', async () => {
    const xpi = writeXpi(path.join(root, 'packed.xpi'), {
      'manifest.json': MANIFEST,
      'background.js': 'void 0\n',
      'icons/16.png': 'not-really-a-png',
    })

    const installed = await installAddon(userDataDir, xpi)

    expect(installed).toMatchObject({ slug: 'packed@vfox.test', version: '9.9.9', files: 3 })
    expect(await fs.readdir(addonDir(userDataDir, installed.slug))).toEqual(
      expect.arrayContaining(['manifest.json', 'background.js', 'icons']),
    )
  })

  it('takes the id from the MV2 `applications` key as well', async () => {
    const source = await writeAddon(path.join(root, 'src', 'legacy'), {
      browser_specific_settings: undefined,
      applications: { gecko: { id: 'legacy@vfox.test' } },
    })
    const installed = await installAddon(userDataDir, source)
    expect(installed).toMatchObject({ slug: 'legacy@vfox.test', id: 'legacy@vfox.test' })
  })

  it('falls back to the source directory name when the manifest has no id', async () => {
    const source = await writeAddon(path.join(root, 'src', 'No Id Addon'), {
      browser_specific_settings: undefined,
    })
    const installed = await installAddon(userDataDir, source)
    expect(installed.slug).toBe('No_Id_Addon')
    expect(installed.id).toBeNull()
  })

  it('refuses a directory without manifest.json and says what an addon is', async () => {
    const source = path.join(root, 'src', 'empty')
    await fs.mkdir(source, { recursive: true })
    await expect(installAddon(userDataDir, source)).rejects.toThrow(/manifest\.json/)
    // Nothing was left behind to confuse the next launch.
    await expect(fs.readdir(addonStoreDir(userDataDir))).resolves.toEqual([])
  })

  it('refuses an .xpi whose manifest.json is nested in a folder', async () => {
    const xpi = writeXpi(path.join(root, 'nested.xpi'), {
      'my-addon/manifest.json': MANIFEST,
    })
    await expect(installAddon(userDataDir, xpi)).rejects.toThrow(/manifest\.json/)
  })

  it('refuses an archive whose entries escape the destination', async () => {
    const xpi = rawZip(path.join(root, 'slip.xpi'), {
      '../escaped.txt': 'gotcha',
      'manifest.json': MANIFEST,
    })
    await expect(installAddon(userDataDir, xpi)).rejects.toThrow(/escapes the addon directory/)
    await expect(fs.stat(path.join(userDataDir, 'escaped.txt'))).rejects.toThrow()
    await expect(fs.readdir(addonStoreDir(userDataDir))).resolves.toEqual([])
  })

  it('refuses a second install under the same id unless replace is asked for', async () => {
    const source = await writeAddon(path.join(root, 'src', 'first'), {}, { 'a.js': '1' })
    await installAddon(userDataDir, source)

    const second = await writeAddon(path.join(root, 'src', 'second'), { version: '2.0.0' })
    await expect(installAddon(userDataDir, second)).rejects.toThrow(/already installed/)

    const replaced = await installAddon(userDataDir, second, { replace: true })
    expect(replaced.version).toBe('2.0.0')
    expect(await listAddons(userDataDir)).toHaveLength(1)
    // The replacement is a real swap, not a merge: the old tree is gone.
    await expect(fs.stat(path.join(addonDir(userDataDir, replaced.slug), 'a.js'))).rejects.toThrow()
  })

  it('leaves the profile untouched when an install fails halfway', async () => {
    const good = await writeAddon(path.join(root, 'src', 'good'), {}, { 'a.js': '1' })
    const installed = await installAddon(userDataDir, good)

    const bad = writeXpi(path.join(root, 'bad.xpi'), { 'nested/manifest.json': MANIFEST })
    await expect(installAddon(userDataDir, bad, { replace: true })).rejects.toThrow()

    const listed = await listAddons(userDataDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.version).toBe(installed.version)
    // No `.staging-*` directory survived the failure.
    expect((await fs.readdir(addonStoreDir(userDataDir))).sort()).toEqual([installed.slug])
  })

  it('removes by slug and by gecko id', async () => {
    await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'one')))
    const two = await installAddon(
      userDataDir,
      await writeAddon(path.join(root, 'src', 'two'), {
        browser_specific_settings: { gecko: { id: 'second@vfox.test' } },
      }),
    )

    expect(await removeAddon(userDataDir, 'test-addon@vfox.test')).toMatchObject({
      slug: 'test-addon@vfox.test',
    })
    expect(await removeAddon(userDataDir, two.slug)).toMatchObject({ id: 'second@vfox.test' })
    expect(await listAddons(userDataDir)).toEqual([])
  })

  it('names what is installed when the target does not match', async () => {
    await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'one')))
    await expect(removeAddon(userDataDir, 'ghost@vfox.test')).rejects.toThrow(
      /No addon "ghost@vfox\.test".*test-addon@vfox\.test/s,
    )
  })

  it('refuses to remove an addon the engine supplies', async () => {
    await expect(removeAddon(userDataDir, 'engine:UBO')).rejects.toThrow(/provided by the engine/)
  })

  it('ignores a directory whose manifest does not parse, so the engine never sees it', async () => {
    await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'one')))
    const broken = path.join(addonStoreDir(userDataDir), 'broken@vfox.test')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'manifest.json'), '{ not json', 'utf8')

    // `confirmPaths` would throw on this directory and fail every launch of the profile.
    const listed = await listAddons(userDataDir)
    expect(listed.map(addon => addon.slug)).toEqual(['test-addon@vfox.test'])
  })
})

describe('the engine’s own addons', () => {
  it('reports them from the engine directory, read-only', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net', 'uBlock Origin')

    const engineAddons = await listEngineAddons(engineDir)

    expect(engineAddons).toHaveLength(1)
    expect(engineAddons[0]).toMatchObject({
      slug: 'engine:UBO',
      id: 'uBlock0@raymondhill.net',
      name: 'uBlock Origin',
      source: 'engine',
    })
  })

  it('reports nothing when the engine ships no addons', async () => {
    expect(await listEngineAddons(path.join(root, 'no-engine'))).toEqual([])
  })

  it('excludes a default the profile has its own copy of, and only that one', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')

    expect(await excludeDefaultAddons(engineDir, ['uBlock0@raymondhill.net'])).toEqual(['UBO'])
    expect(await excludeDefaultAddons(engineDir, ['something@else.test'])).toEqual([])
    expect(await excludeDefaultAddons(engineDir, [])).toEqual([])
  })

  /**
   * The directory camoufox-js creates before a download it never finishes. It pushes such a path
   * without looking inside it (`dist/addons.js:59-64`) and then throws on it in `confirmPaths`
   * (`:16-24`), which reaches the user as a 500 on the launch. Pruning it is the repair camoufox-js
   * applies to itself after a failed download, applied by the side that keeps meeting the directory.
   */
  it('removes an engine addon directory with no manifest, so the engine downloads it again', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')
    const broken = path.join(engineDir, 'addons', 'UBO')
    // Exactly what a download that failed after `mkdirSync` leaves: the directory, no manifest.
    await fs.rm(path.join(broken, 'manifest.json'))
    expect(existsSync(broken)).toBe(true)

    expect(await pruneEngineAddons(engineDir)).toEqual(['UBO'])
    expect(existsSync(broken)).toBe(false)
  })

  it('leaves a usable engine addon exactly as it is', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')
    const good = path.join(engineDir, 'addons', 'UBO')
    const before = await fs.readFile(path.join(good, 'manifest.json'), 'utf8')

    expect(await pruneEngineAddons(engineDir)).toEqual([])
    expect(existsSync(good)).toBe(true)
    expect(await fs.readFile(path.join(good, 'manifest.json'), 'utf8')).toBe(before)
  })

  it('removes an unreadable manifest and a non-directory entry, and survives a missing root', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')
    const addons = path.join(engineDir, 'addons')
    await fs.writeFile(path.join(addons, 'partial.xpi'), 'not an addon directory')
    await fs.mkdir(path.join(addons, 'half-extracted'), { recursive: true })
    await fs.writeFile(path.join(addons, 'half-extracted', 'manifest.json'), '{ truncated')

    // Sorted: `readdir` order is the filesystem's, not ours, and an order-dependent assertion here
    // would pass on Windows and fail on the Linux runner — the same mistake the kernel fixtures made
    // with `camoufox.exe`.
    expect((await pruneEngineAddons(engineDir)).sort()).toEqual(['half-extracted', 'partial.xpi'])
    expect(existsSync(path.join(addons, 'UBO'))).toBe(true)
    // No engine directory at all is not an error: it is the state before the first install.
    expect(await pruneEngineAddons(path.join(root, 'no-engine'))).toEqual([])
  })
})

/* ------------------------------------------------------------------ the launcher wiring */

const engineRoot = process.env.CAMOUFOX_INSTALL_DIR ?? ''
const engineAvailable = existsSync(path.join(engineRoot, 'properties.json'))

/** The CAMOU_CONFIG the engine will actually read, reassembled from its env chunks. */
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

function profile(id = 'p1') {
  return ProfileSchema.parse({
    id,
    name: id,
    fingerprint: { geoip: false },
    launch: {},
    createdAt: 'x',
    updatedAt: 'x',
  })
}

describe.skipIf(!engineAvailable)('what the launcher is handed', () => {
  /**
   * `options.addons` is not the thing to assert: camoufox-js destructures the option out and assigns
   * it to `config.addons` itself (`dist/utils.js:384-390`), which is what the engine reads back out
   * of `CAMOU_CONFIG`. Asserting the option object instead of the config is exactly how the first
   * version of this wiring passed nothing at all — the addon never reached the browser, and only the
   * engine's own default was loaded.
   */
  it('hands the engine the profile’s addons as absolute paths', async () => {
    const installed = await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'a')))
    const expected = addonDir(userDataDir, installed.slug)
    expect(path.isAbsolute(expected)).toBe(true)

    const config = camouConfig(await toServerOptions(profile(), userDataDir, vi.fn()))

    expect(config.addons).toContain(expected)
  })

  it('does not accumulate the engine’s defaults across launches', async () => {
    const installed = await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'b')))
    const first = camouConfig(await toServerOptions(profile(), userDataDir, vi.fn()))
    const second = camouConfig(await toServerOptions(profile(), userDataDir, vi.fn()))

    // camoufox-js pushes its default addon paths into the array it was given, so a shared or cached
    // array would come back one entry longer on every launch.
    expect(second.addons).toEqual(first.addons)
    expect(first.addons).toContain(addonDir(userDataDir, installed.slug))
  })

  it('excludes the engine’s copy of an addon the profile also has', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')
    await installAddon(
      userDataDir,
      await writeAddon(path.join(root, 'src', 'own-ubo'), {
        browser_specific_settings: { gecko: { id: 'uBlock0@raymondhill.net' } },
      }),
    )

    const config = camouConfig(await toServerOptions(profile(), userDataDir, vi.fn(), engineDir))

    // `exclude_addons` is observable as an effect: with it, the engine's own copy is absent. Without
    // it this array would hold two entries for one gecko id — a conflict Firefox resolves silently.
    expect(config.addons).toEqual([addonDir(userDataDir, 'uBlock0@raymondhill.net')])
  })

  it('contributes nothing to a profile with no addons of its own', async () => {
    const config = camouConfig(await toServerOptions(profile(), userDataDir, vi.fn()))
    const addons = (config.addons ?? []) as string[]

    expect(addons.some(entry => entry.includes(ADDON_STORE_DIR))).toBe(false)
  })

  /**
   * The wiring, not the helper: this is the assertion that goes red when the `pruneEngineAddons` call
   * is removed from `toServerOptions()`. Without the call, the broken directory survives the launch and
   * camoufox-js hands its path to `confirmPaths`, which throws — the 500 this change exists to stop.
   */
  it('prunes a broken engine addon before the paths are handed to camoufox-js', async () => {
    const engineDir = await writeEngineAddon('UBO', 'uBlock0@raymondhill.net')
    const broken = path.join(engineDir, 'addons', 'UBO')
    await fs.rm(path.join(broken, 'manifest.json'))
    const warn = vi.fn()

    await toServerOptions(profile(), userDataDir, warn, engineDir)

    expect(existsSync(broken)).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toContain('UBO')
  })
})

/** The store must be invisible to a profile that never used it. */
it('tolerates a profile whose userdata directory does not exist yet', async () => {
  const missing = path.join(root, 'never-launched', 'userdata')
  expect(await listAddons(missing)).toEqual([])
  expect(ADDON_STORE_DIR).toBe('vfox-addons')
})
