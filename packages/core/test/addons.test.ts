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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { unknownPropertyKey } from '../src/engine-config.js'
import { toServerOptions } from '../src/launcher.js'

let root: string
let userDataDir: string
/** The fixture engine directory, created per test and pointed at by `CAMOUFOX_INSTALL_DIR`. */
let engineDir: string

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
  const engineDir = await fakeEngine()
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

/**
 * An engine directory that is not an engine, but is shaped like one.
 *
 * Every case in the block below passes this in as `engineDir`. That is not tidiness: without it
 * `toServerOptions` falls back to `resolveEngineDir()`, which on CI points at an empty cache with no
 * `version.json`, and camoufox-js then starts its own release lookup and throws
 * `Version information not found at …\version.json. Please run \`camoufox fetch\` to install.` - which
 * is the mechanism issue #79 is about, reproduced by a test fixture that was not shaped like the thing
 * it stood in for.
 */
async function fakeEngine(): Promise<string> {
  // WHAT THIS MUST NOT DO, written here because a change reached into it THREE TIMES in one PR: it
  // builds a fixture, and it must stay that. Anything it calls runs for every block in this file, so a
  // helper added here for one block's contract will break the others - which is what happened when the
  // schema derivation, and before it `createIdentity`, were wired in below. If a block needs more than
  // a usable engine directory, it asks for it at its own call site.
  const engineDir = path.join(root, 'engine')
  await fs.mkdir(engineDir, { recursive: true })
  await writeEngineProperties(engineDir)
  return engineDir
}

/**
 * A fake engine needs three things, and each one was learned from a failure.
 *
 * 1. `properties.json` - camoufox-js reads it from the directory the executable lives in
 *    (`dist/utils.js:61-76`) and validates the whole CAMOU_CONFIG against it, throwing
 *    `UnknownProperty` for any key it does not list (`:77-87`). VFox has its own tolerance
 *    (`acceptedKeys` in `engine-config.ts` returns `null` for a schema it does not understand), so a
 *    fixture WITHOUT the file does not fail politely - it fails inside camoufox-js, on whichever key it
 *    reaches first.
 *
 * 2. `version.json` - and this one is the whole reason the block below used to skip. Every launch
 *    reaches camoufox-js's `camoufoxPath()` through the ADDON path, and that function starts its OWN
 *    engine download when the root has no readable `version.json`. Measured: ten outbound requests from
 *    one launch in that state, and `Version information not found at …\version.json. Please run
 *    \`camoufox fetch\` to install.` It is two fields, `version` and `release`, NOT one combined string.
 *    With it, the same launch makes five requests instead of ten - the difference is the release lookup,
 *    and it is the mechanism issue #79 is about.
 *
 * 3. the addon directory itself.
 *
 * This is also why the block no longer skips. It was gated on
 * `existsSync(<CAMOUFOX_INSTALL_DIR>/properties.json)`, so on CI - which installs no engine - the whole
 * launcher-wiring contract was asserted NOWHERE, while on a developer's machine the same commit failed
 * with `ENOENT: … engine\properties.json`. Same code, two environments, two results, and the one that
 * mattered was the silent one. The fixture builds what it needs, so the block runs everywhere.
 */
/**
 * camoufox-js's type vocabulary for a `properties.json` entry (`dist/utils.js:88-107`), and its
 * `default` arm is a trap: an unrecognised type string returns false for EVERY value, so one wrong
 * spelling takes the whole block down with a message about the config rather than about the type. The
 * string type is `str`, NOT `string` - that is the first spelling anyone reaches for. Valid: str,
 * int, uint, double, bool, array, dict.
 */
function typeOf(value: unknown): string {
  return Array.isArray(value)
    ? 'array'
    : typeof value === 'number'
      ? Number.isInteger(value)
        ? 'int'
        : 'double'
      : typeof value === 'boolean'
        ? 'bool'
        : typeof value === 'object' && value !== null
          ? 'dict'
          : 'str'
}

/**
 * The config `toServerOptions` ACTUALLY hands over - the exact object `validateConfig` rejects.
 *
 * This is the fifth attempt at the fixture's schema and the first that predicts nothing. Enumerating
 * keys by hand, deriving from the pin set, flattening the fingerprint and mapping through
 * `fromBrowserforge` were all attempts to guess this object; each was wrong in a different way, and the
 * last was wrong the same way as the one before it, one level up - the option names are not the
 * CAMOU_CONFIG names. Reading it removes the prediction, which is why it is the last attempt.
 *
 * CAMOU_CONFIG is not on `options.config`: it travels in `env` as chunked variables
 * (`CAMOU_CONFIG_<n>`, 2047 chars each), which is what `camouConfig` reassembles.
 */
async function observedConfig(engineDir: string): Promise<Record<string, unknown>> {
  return camouConfig(await toServerOptions(profile(), userDataDir, vi.fn(), engineDir))
}

/**
 * Declare the schema by ASKING THE VALIDATOR, one rejected key at a time.
 *
 * This is the sixth attempt at this fixture and the first that does not model the validator. The five
 * before it were: a hand-written list (CI named the missing keys eight at a time, twice); a derivation
 * from the pin set (missed the fingerprint's keys); a flatten of the fingerprint (wrong names -
 * `screen.screenX` where the config has `window.screenX`); a mapper through `fromBrowserforge` (right
 * names, still missing `fonts`); and a permissive schema, which this validator does not have - every key
 * must be declared, and declaring them is what observing them was for.
 *
 * So it asks instead. `validateConfig` (`dist/utils.js:77-87`) throws on the FIRST key it does not
 * know and names it; `InvalidPropertyType` names the key AND the type it expected. Both messages were
 * read from the source, not inferred:
 *
 *     throw new UnknownProperty(`Unknown property ${key} in config`)
 *     throw new InvalidPropertyType(`Invalid type for property ${key}. Expected ${expectedType}, got …`)
 *
 * ONE SAMPLE, AND THAT IS ITS LIMIT, worth knowing rather than rediscovering: the loop converges on the
 * config for ONE profile on ONE platform, which is what the launcher block passes. A key that appears
 * only for another OS, or only under the `fingerprint.config` escape hatch, is not declared here - and a
 * later block exercising those will meet `UnknownProperty` again with a fresh key. That is the same gap
 * as the pin-set derivation, one level out: the guessing is gone, but the sample is one.
 */
async function convergeSchema(engineDir: string): Promise<Record<string, unknown>> {
  // SEEDED WITH `addons`, and the seed is load-bearing. This loop writes `properties.json` itself and
  // writes exactly `[...declared]` - it does NOT go through `writeEngineProperties`, which is the one
  // place that hardcodes `addons`. So an unseeded map converges on a schema that omits the single key
  // camoufox-js assigns to every config, and every later launch reads a fixture whose own author thought
  // it declared `addons`: "Unknown property addons in config", from a file that was supposed to accept
  // it. Found by ci, who narrowed it to this one line from the probe's output.
  const declared = new Map<string, string>([['addons', 'array']])
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    await fs.writeFile(
      path.join(engineDir, 'properties.json'),
      JSON.stringify([...declared].map(([property, type]) => ({ property, type }))),
      'utf8',
    )
    try {
      const config = await observedConfig(engineDir)
      // PRINTED, because the count is what turns the next schema question into a number in the log
      // rather than a CI cycle - and because "converged in N attempts" is how many keys the config has.
      console.log(
        `engine fixture: schema converged after ${attempt} attempt(s); ` +
          `${Object.keys(config).length} CAMOU_CONFIG key(s) declared`,
      )
      return config
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      // SHAPE 1 — ONE key, parsed by the PRODUCT'S OWN PARSER. `unknownPropertyKey`
      // (`engine-config.ts:98`) does exactly what the regex here used to do, including "rethrow
      // unchanged when it is something else". Hand-rolling it was the sixth time this PR reimplemented
      // something the product exports, and this one was four lines from the code being fought.
      const unknownKey = unknownPropertyKey(error)
      // ONLY WHEN IT IS NEW. On the first pass the key is undeclared and `dict` is the best guess; on the
      // next pass the same key comes back as a TYPE error, and `unknownPropertyKey` still names it - so
      // without this guard shape 1 matched every single attempt, re-set the same key to the same guess,
      // and `continue`d before shapes 2 and 3 could run. That is why the loop reported "1 key(s)
      // declared" after sixty-four attempts: one key learned, sixty-three attempts spent re-learning it.
      if (unknownKey && !declared.has(unknownKey)) {
        declared.set(unknownKey, 'dict') // type unknown yet; shape 3 corrects it on the next pass
        continue
      }
      // SHAPE 2 — VFox intercepts `UnknownProperty`, drops the key, retries, and when the retry still
      // fails it throws ITS OWN message naming a LIST (`engine-config.ts:164`). That is why the loop
      // stalled after one key: the error stopped being camoufox-js's and stopped naming a single key.
      // These are the keys `suppressUnknownKeys` re-adds after the drop, which is why dropping them
      // does not help.
      const listed = /even after dropping them:\s*(.+)$/m.exec(message)?.[1]
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
      // SHAPE 3 — the type, and the message has to be read the RIGHT WAY ROUND. `Expected dict, got
      // number` does NOT mean "this key should be dict": it means "your declaration said dict and the
      // value is a number". Reading `Expected` set the key to the type it already had, so `declared.set`
      // was a no-op, the loop re-learned the same non-fact, and nine keys sat there for sixty-four
      // attempts. The type to declare is the one that ACCEPTS THE VALUE, which is what `got` names.
      //
      // The map is deliberately the permissive spelling of each: a `number` becomes `double` because
      // `int` would reject a float and `double` accepts both, and `double` is the engine's own
      // vocabulary (`utils.js` `validateType`). Anything unrecognised falls through to the throw rather
      // than guessing, so a new JavaScript type shows up as a failure instead of a silent wrong answer.
      const TYPE_ACCEPTING: Record<string, string> = {
        number: 'double',
        string: 'str',
        boolean: 'bool',
        object: 'dict',
      }
      const wrongType = /Invalid type for property (\S+)\. Expected \w+, got (\w+)/.exec(message)
      const wrongTypeKey = wrongType?.[1]
      const wrongTypeGot = wrongType?.[2]
      let wrongTypeValue = wrongTypeGot ? TYPE_ACCEPTING[wrongTypeGot] : undefined
      // `got object` is ambiguous, and the ambiguity is real: `typeof []` is `'object'`, so an array and
      // a dict produce the same word. The message cannot settle it and the value is in the config this
      // loop is trying to observe, so asking for it is circular. What settles it is the second attempt:
      // a value the validator rejects as `dict` while calling it an object is an array, because the only
      // other thing JavaScript calls an object is a dict and that is what just failed.
      if (wrongTypeGot === 'object' && wrongTypeKey && declared.get(wrongTypeKey) === 'dict') {
        wrongTypeValue = 'array'
      }
      if (wrongTypeKey && wrongTypeValue && declared.get(wrongTypeKey) !== wrongTypeValue) {
        declared.set(wrongTypeKey, wrongTypeValue)
        continue
      }
      throw error
    }
  }
  throw new Error(
    `the engine schema did not converge in 64 attempts (${declared.size} key(s) declared)`,
  )
}

async function writeEngineProperties(
  engineDir: string,
  keys?: Record<string, unknown>,
): Promise<void> {
  // DERIVED, NOT ENUMERATED — and this comment matters more than the list it replaces.
  //
  // The list used to be hand-written, and CI named the keys it was missing EIGHT AT A TIME over two
  // runs: `window.screenX, screen.width, screen.height, …` and then `screen.colorDepth,
  // screen.pixelDepth, navigator.userAgent, …`. A hand-written list that fails whenever the product
  // grows a key is a test that gets "fixed" by adding the key, which is the habit this repository keeps
  // writing down.
  //
  // THE KEYS COME FROM THE PRODUCT. `createIdentity(...).config` is documented as "Config keys to pin so
  // the engine cannot re-roll them" — it IS the CAMOU_CONFIG key set, and it needs no engine.
  //
  // WHY IT DERIVES FROM AN IDENTITY AND NOT FROM THE CONFIG UNDER TEST: deriving from the config being
  // validated would declare every key that config contains, and this block would assert nothing at all.
  // Deriving from a generated identity leaves a rogue config key UNDECLARED, so it still fails here by
  // name. Deriving from the wrong side is the one-line mistake that turns this into a check that cannot
  // fail, which is why the source is named here rather than left to the reader.
  //
  // THE TYPE VOCABULARY IS camoufox-js's (`dist/utils.js:88-107`) AND ITS `default` ARM IS A TRAP: an
  // unrecognised type string returns false for EVERY value, so one wrong spelling takes this whole block
  // down with a message about the config rather than about the type. The string type is `str`, NOT
  // `string` — that is the first spelling anyone reaches for. Valid: str, int, uint, double, bool,
  // array, dict.
  // PASS 1 - a schema VFox does not understand, so the launch goes ahead as-is. `acceptedKeys` returns
  // `null` for anything that is not an array of `{ property, type }`, and `dropUnacceptedKeys` then
  // passes the config through untouched - which is what makes the observation in pass 2 possible.
  //
  // This is safe because camoufox-js's `loadProperties` reads the file on EVERY call
  // (`dist/utils.js:61-76`, `readFileSync` with no memoisation) and its only call site passes the
  // `executable_path` of that launch (`:425`). There is no cache to defeat, so the two passes are not
  // circular - verified from the source rather than assumed.
  // `[]`, NOT `{}`. `loadProperties` calls `propDict.reduce` unconditionally (`dist/utils.js:72`), so
  // an object throws "propDict.reduce is not a function" BEFORE `acceptedKeys` is ever consulted - and an
  // empty array reduces to `{}`, which makes `validateConfig` reject the first key and gives the
  // convergence loop below its first error to learn from. That pair of characters is the difference
  // between the loop starting and the loop never running.
  await fs.writeFile(path.join(engineDir, 'properties.json'), JSON.stringify([]), 'utf8')
  // Two fields, not one: `formatKernelVersion()` joins them and `readKernelVersion()` splits them back.
  await fs.writeFile(
    path.join(engineDir, 'version.json'),
    JSON.stringify({ version: '152.0.4', release: 'beta.30' }),
    'utf8',
  )

  // OPT-IN, AND THIS IS THE THIRD TIME THIS PR HAS LEARNED THE SAME LESSON. `writeEngineProperties` is
  // called by `fakeEngine()`, which `writeEngineAddon()` calls, which EVERY block uses. Deriving the
  // schema here ran `toServerOptions` inside a helper five blocks share - and it needs a profile and a
  // userDataDir those blocks are not set up for, so five tests in `the engine's own addons` went red
  // for a reason that had nothing to do with them.
  //
  // The shared helper builds a fixture. The block whose contract is about the config asks for the
  // derived one.
  if (!keys) return
  await fs.writeFile(
    path.join(engineDir, 'properties.json'),
    JSON.stringify([
      { property: 'addons', type: 'array' },
      ...Object.entries(keys).map(([property, value]) => ({ property, type: typeOf(value) })),
    ]),
    'utf8',
  )
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

/**
 * NO `skipIf` HERE, and that is the point of this block.
 *
 * It used to be `describe.skipIf(!existsSync(<CAMOUFOX_INSTALL_DIR>/properties.json))`. CI installs no
 * engine, so the entire launcher-wiring contract - what the engine is actually handed, which is the
 * thing `toServerOptions` exists to get right - was asserted NOWHERE in the environment every merge is
 * judged in. On a machine that had an engine the same commit failed instead, with
 * `ENOENT: … engine\properties.json`. Two environments, two results, and the silent one was CI.
 *
 * Everything this block needs it now builds itself: `writeEngineAddon` writes the addon AND a
 * `properties.json` for the fake engine it creates, and each case passes that directory in explicitly.
 * A block that skips is a block that cannot fail, and this repository has that defect class written
 * down seven times.
 */

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

describe('what the launcher is handed', () => {
  /**
   * `CAMOUFOX_INSTALL_DIR` MUST POINT AT THE FIXTURE, and passing `engineDir` to `toServerOptions` is
   * not enough on its own.
   *
   * Every launch reaches camoufox-js's `camoufoxPath()` through the ADDON path, and that function reads
   * `getPath('version.json')` - which resolves from `CAMOUFOX_INSTALL_DIR`, frozen when camoufox-js is
   * loaded. With it pointing at CI's empty cache the launch throws
   * `Version information not found at …\version.json. Please run \`camoufox fetch\` to install.` no
   * matter what the caller passes. Measured on CI, which is why this block now pins it instead of
   * skipping on it.
   *
   * AGENTS.md already records the shape of this - "pin `CAMOUFOX_INSTALL_DIR` at an empty directory (or
   * a fixture engine directory) inside the case" - and the previous version of this block did the
   * opposite: it SKIPPED when the variable did not point at an engine, so CI asserted nothing at all.
   */
  /**
   * ONE fixture directory for the whole block, created once and never removed between cases.
   *
   * This is not tidiness, it is the whole reason the block used to skip. camoufox-js resolves
   * `CAMOUFOX_INSTALL_DIR` when it is LOADED, and every launch reaches its `camoufoxPath()` through the
   * ADDON path - so the first value this process sets is the one every later test is measured against.
   * A per-test fixture therefore works for the first case and points at a deleted directory for all the
   * rest, which surfaces as `Version information not found at /tmp/vfox-addons-XXXX/engine/version.json`
   * - an error about the fixture, wearing the library's words, three tests after the mistake.
   *
   * The per-test assertion is kept: if the fixture ever fails to materialise, that says so directly
   * instead of arriving as a camoufox-js message about a missing version file.
   */
  // SAVE AND RESTORE — a test that changes a PROCESS-WIDE variable leaves the process as it found it.
  //
  // `CAMOUFOX_INSTALL_DIR` is process-wide, camoufox-js freezes it when it is LOADED, and this file now
  // has two blocks that care about it for different reasons. `afterAll` below deletes the fixture
  // directory, so a variable left pointing at it makes every later lookup resolve to a path that no
  // longer exists — which is how a change to this block reached past it and failed a block that had been
  // passing. The module-level `engineDir` is captured and restored for the same reason: it is shared
  // state, and assigning it here without putting it back is the same defect one level up.
  const previousInstallDir = process.env.CAMOUFOX_INSTALL_DIR
  const previousEngineDir = engineDir

  beforeAll(async () => {
    // Its OWN directory, not `root`: `beforeAll` runs before the outer `beforeEach` creates `root`, and
    // the fixture has to outlive every case anyway - see the docblock above.
    engineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-fixture-engine-'))
    // POINTED AT THE FIXTURE FIRST, and this line's POSITION is the whole reason pass 2 works.
    //
    // `observedConfig` calls `toServerOptions`, which calls camoufox-js's `launchOptions`, which reaches
    // `camoufoxPath()` through the addon path - and that one reads `<CAMOUFOX_INSTALL_DIR>/version.json`
    // (`pkgman.js:98` via `installedVerStr` at `:298`, reached from `utils.js:398`). With the variable
    // still pointing at CI's empty cache the observation threw `Version information not found`, which is
    // the mechanism issue #79 is about, reproduced by the fixture that was supposed to answer it.
    process.env.CAMOUFOX_INSTALL_DIR = engineDir
    // PASS 1: the permissive schema and the marker, so the fixture is usable at all.
    await writeEngineProperties(engineDir)
    // PASS 2: read what the product actually hands over - the one thing this fixture never did in its
    // first four versions, all of which predicted that object instead of asking for it.
    const observed = await convergeSchema(engineDir)
    // PASS 3: the real schema, derived from what was observed.
    await writeEngineProperties(engineDir, observed)
    for (const file of ['properties.json', 'version.json']) {
      if (!existsSync(path.join(engineDir, file))) {
        throw new Error(`the fixture engine is missing ${file} at ${engineDir}`)
      }
    }
  })

  afterAll(async () => {
    await fs.rm(engineDir, { recursive: true, force: true })
    // Put the process back. `delete` rather than assigning `undefined`, which would leave the variable
    // DEFINED with the string "undefined" — a different environment, and one that fails somewhere else.
    if (previousInstallDir === undefined) delete process.env.CAMOUFOX_INSTALL_DIR
    else process.env.CAMOUFOX_INSTALL_DIR = previousInstallDir
    engineDir = previousEngineDir
  })

  beforeEach(() => {
    // Re-asserted rather than re-created: the directory outlives every case, and this makes the
    // dependency visible in the hook that needs it.
    process.env.CAMOUFOX_INSTALL_DIR = engineDir
  })

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

    const config = camouConfig(
      await toServerOptions(profile(), userDataDir, vi.fn(), await fakeEngine()),
    )

    expect(config.addons).toContain(expected)
  })

  it('does not accumulate the engine’s defaults across launches', async () => {
    const installed = await installAddon(userDataDir, await writeAddon(path.join(root, 'src', 'b')))
    const first = camouConfig(
      await toServerOptions(profile(), userDataDir, vi.fn(), await fakeEngine()),
    )
    const second = camouConfig(
      await toServerOptions(profile(), userDataDir, vi.fn(), await fakeEngine()),
    )

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
    const config = camouConfig(
      await toServerOptions(profile(), userDataDir, vi.fn(), await fakeEngine()),
    )
    const addons = (config.addons ?? []) as string[]

    expect(addons.some(entry => entry.includes(ADDON_STORE_DIR))).toBe(false)
  })
})

/** The store must be invisible to a profile that never used it. */
it('tolerates a profile whose userdata directory does not exist yet', async () => {
  const missing = path.join(root, 'never-launched', 'userdata')
  expect(await listAddons(missing)).toEqual([])
  expect(ADDON_STORE_DIR).toBe('vfox-addons')
})
