/**
 * `vfox addons list|add|remove` against a **real** `@vfox/core` and a real addon store.
 *
 * This is as far as a machine that cannot launch a browser can go: the addon is a real extracted
 * directory, the `.xpi` is a real archive, and the store is read back from disk. What it cannot show
 * is that the engine *loads* what is stored — that needs a launch, and `verify-window.mjs` asserts it
 * in CI on a real headed profile.
 *
 * It does prove the promise the layout was chosen for: addons live inside the profile's own data
 * directory, so `vfox clone`, `vfox export` and `vfox import` carry them without any addon-specific
 * code in those paths.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseJson, runCli } from './helpers/run-cli.mjs'

// Creating a profile runs browserforge's generator, and the export/import cases zip a profile.
vi.setConfig({ testTimeout: 60_000 })

let dataDir
let workspace

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-cli-addons-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'vfox-cli-addons-src-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const withDir = (...args) => [...args, '--data-dir', dataDir]

async function createProfile(name = 'Alpha') {
  const result = await runCli(withDir('create', name, '--json'))
  expect(result.code).toBe(0)
  return parseJson(result.stdout)
}

/** An extracted addon: the engine's unit. */
async function writeAddon(name, id = 'probe@vfox.test', version = '1.0.0') {
  const dir = path.join(workspace, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 2,
        name,
        version,
        browser_specific_settings: { gecko: { id } },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(path.join(dir, 'probe.js'), 'void 0\n', 'utf8')
  return dir
}

/** The same addon as an .xpi, which VFox has to extract itself. */
async function writeXpi(name, id = 'packed@vfox.test') {
  const file = path.join(workspace, `${name}.xpi`)
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        manifest_version: 2,
        name,
        version: '9.9.9',
        browser_specific_settings: { gecko: { id } },
      }),
      'utf8',
    ),
  )
  zip.addFile('background.js', Buffer.from('void 0\n', 'utf8'))
  zip.writeZip(file)
  return file
}

async function listAddons(profile = 'Alpha') {
  const result = await runCli(withDir('addons', 'list', profile, '--json'))
  expect(result.code).toBe(0)
  return parseJson(result.stdout).addons
}

/**
 * Run something with `CAMOUFOX_INSTALL_DIR` pointed at `dir`.
 *
 * The CLI runs in-process and `resolveEngineDir()` re-reads that variable on every call, so this is
 * how a case pins what the engine ships instead of inheriting whatever the machine happens to have.
 * A developer machine has the engine and therefore its default addon; the Linux CI runner has
 * neither — and a case whose result differs between the two is not a test, it is a coin flip.
 */
async function withEngineDir(dir, run) {
  const previous = process.env.CAMOUFOX_INSTALL_DIR
  process.env.CAMOUFOX_INSTALL_DIR = dir
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.CAMOUFOX_INSTALL_DIR
    else process.env.CAMOUFOX_INSTALL_DIR = previous
  }
}

/** What the CI runner looks like: an engine directory that holds nothing. */
async function withoutEngine(run) {
  const dir = path.join(workspace, 'no-engine')
  await mkdir(dir, { recursive: true })
  return withEngineDir(dir, run)
}

/** A stand-in engine directory holding one default addon, so the case does not depend on the machine. */
async function writeEngineDefault(key, id, name) {
  const engineDir = path.join(workspace, `engine-${key}`)
  const dir = path.join(engineDir, 'addons', key)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name,
      version: '1.0.0',
      browser_specific_settings: { gecko: { id } },
    }),
    'utf8',
  )
  return engineDir
}

describe('vfox addons add', () => {
  it('installs an extracted addon and reports it', async () => {
    await createProfile()
    const dir = await writeAddon('My Addon')

    const result = await runCli(withDir('addons', 'add', 'Alpha', dir, '--json'))
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout).addon).toMatchObject({
      slug: 'probe@vfox.test',
      id: 'probe@vfox.test',
      name: 'My Addon',
      version: '1.0.0',
      source: 'vfox',
      files: 2,
    })

    expect((await listAddons()).map(addon => addon.slug)).toContain('probe@vfox.test')
  })

  it('extracts an .xpi, because the engine only loads directories', async () => {
    await createProfile()
    const xpi = await writeXpi('Packed')

    const result = await runCli(withDir('addons', 'add', 'Alpha', xpi, '--json'))
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout).addon).toMatchObject({
      slug: 'packed@vfox.test',
      version: '9.9.9',
    })
  })

  it('says the addon loads on the next launch, in human mode', async () => {
    await createProfile()
    const dir = await writeAddon('My Addon')
    const result = await runCli(withDir('addons', 'add', 'Alpha', dir))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Installed My Addon 1.0.0')
    expect(result.stderr).toContain('loads the next time this profile is launched')
  })

  it('refuses a second install under the same id unless --replace', async () => {
    await createProfile()
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('First')))

    const again = await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Second')))
    expect(again.code).toBe(1)
    expect(again.stderr).toContain('already installed')

    const replaced = await runCli(
      withDir(
        'addons',
        'add',
        'Alpha',
        await writeAddon('Third', 'probe@vfox.test', '3.0.0'),
        '--replace',
        '--json',
      ),
    )
    expect(replaced.code).toBe(0)
    expect(parseJson(replaced.stdout).addon).toMatchObject({ version: '3.0.0' })

    // Only the addons VFox manages: a list also reports the engine's own default addon
    // (`source: 'engine'`), which is present on any machine with an engine installed and is not
    // what this test is about. What must not happen is a second copy of *our* addon.
    const ours = (await listAddons()).filter(addon => addon.source === 'vfox')
    expect(ours).toHaveLength(1)
    expect(ours[0]).toMatchObject({ slug: 'probe@vfox.test', version: '3.0.0' })
  })

  it('fails when the source does not exist', async () => {
    await createProfile()
    const result = await runCli(withDir('addons', 'add', 'Alpha', path.join(workspace, 'missing')))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Addon source not found')
  })

  it('fails when the directory has no manifest.json', async () => {
    await createProfile()
    const empty = path.join(workspace, 'empty')
    await mkdir(empty, { recursive: true })
    const result = await runCli(withDir('addons', 'add', 'Alpha', empty))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('manifest.json')
  })

  it('requires a path', async () => {
    await createProfile()
    const result = await runCli(withDir('addons', 'add', 'Alpha'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing path')
  })
})

describe('vfox addons list', () => {
  it('prints a table with the addon it has, whether or not an engine is installed', async () => {
    await createProfile()
    // The table shape is asserted on an addon this test creates. The engine's own default addon is
    // present on a developer machine and absent on the Linux CI runner, so a shape assertion that
    // leaned on it would pass here and fail there — which is exactly what happened in #81.
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Mine')))

    const result = await runCli(withDir('addons', 'list', 'Alpha'))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('SLUG')
    expect(result.stdout).toContain('NAME')
    expect(result.stdout).toContain('probe@vfox.test')
    expect(result.stdout).toContain('vfox')
  })

  it('prints (none) and says so when the profile has no addons of its own', async () => {
    await createProfile()
    // Pinned to an empty engine directory: that is the CI runner, and it is the only way this case
    // is the same on a machine that has the engine installed (where the list still holds the
    // engine's read-only default, so it is not empty).
    const result = await withoutEngine(() => runCli(withDir('addons', 'list', 'Alpha')))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('(none)')
    expect(result.stdout).not.toContain('SLUG')
    expect(result.stderr).toContain('no addons of its own')
  })

  it('shows the engine’s own addons as read-only, from a fixture engine directory', async () => {
    await createProfile()
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Mine')))
    const engineDir = await writeEngineDefault('UBO', 'uBlock0@raymondhill.net', 'uBlock Origin')

    const listed = await withEngineDir(engineDir, () =>
      runCli(withDir('addons', 'list', 'Alpha', '--json')),
    )
    expect(listed.code).toBe(0)
    const engine = parseJson(listed.stdout).addons.filter(addon => addon.source === 'engine')
    expect(engine.map(addon => addon.slug)).toEqual(['engine:UBO'])
    expect(engine[0]).toMatchObject({ name: 'uBlock Origin', id: 'uBlock0@raymondhill.net' })

    const human = await withEngineDir(engineDir, () => runCli(withDir('addons', 'list', 'Alpha')))
    expect(human.stderr).toContain('come from the engine itself')
  })

  it('fails on an unknown profile', async () => {
    const result = await runCli(withDir('addons', 'list', 'ghost'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile: ghost')
  })
})

describe('vfox addons remove', () => {
  it('removes by slug and by gecko id', async () => {
    await createProfile()
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Mine')))
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Other', 'other@vfox.test')))

    const byId = await runCli(withDir('addons', 'remove', 'Alpha', 'probe@vfox.test', '--json'))
    expect(byId.code).toBe(0)
    expect(parseJson(byId.stdout).removed).toMatchObject({ slug: 'probe@vfox.test' })

    const bySlug = await runCli(withDir('addons', 'remove', 'Alpha', 'other@vfox.test'))
    expect(bySlug.code).toBe(0)
    expect(bySlug.stdout).toContain('Removed Other 1.0.0')

    expect((await listAddons()).filter(addon => addon.source === 'vfox')).toEqual([])
  })

  it('refuses an addon the engine supplies', async () => {
    await createProfile()
    const result = await runCli(withDir('addons', 'remove', 'Alpha', 'engine:UBO'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('provided by the engine')
  })

  it('names what is installed when the target does not match', async () => {
    await createProfile()
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Mine')))
    const result = await runCli(withDir('addons', 'remove', 'Alpha', 'ghost@vfox.test'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No addon "ghost@vfox.test"')
    expect(result.stderr).toContain('probe@vfox.test')
  })
})

describe('vfox addons (dispatch)', () => {
  it('rejects an unknown action', async () => {
    const result = await runCli(withDir('addons', 'frobnicate', 'Alpha'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown addons action')
  })

  it('requires an action', async () => {
    const result = await runCli(withDir('addons'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing action')
  })

  it('documents itself in the top-level help', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('vfox addons list|add|remove')
  })
})

describe('addons travel with the profile', () => {
  it('clone carries them, because they live inside the profile data directory', async () => {
    await createProfile('Source')
    await runCli(withDir('addons', 'add', 'Source', await writeAddon('Mine')))

    const cloned = await runCli(withDir('clone', 'Source', 'Copy', '--json'))
    expect(cloned.code).toBe(0)
    const copy = parseJson(cloned.stdout)

    const addons = await listAddons(copy.name ?? 'Copy')
    expect(addons.map(addon => addon.slug)).toContain('probe@vfox.test')
  })

  it('export and import carry them, which is why a profile zip is executable content', async () => {
    await createProfile('Source')
    await runCli(withDir('addons', 'add', 'Source', await writeAddon('Mine')))

    // The destination is positional; `--out` is not a flag on this command.
    const zip = path.join(workspace, 'profile.zip')
    expect((await runCli(withDir('export', 'Source', zip))).code).toBe(0)

    // The addon store is inside `userdata`, which is what the exporter walks — so the archive has to
    // contain it. Asserting the entries rather than only the end state is what makes this a test of
    // the layout rather than of `import`.
    const entries = new AdmZip(zip).getEntries().map(entry => entry.entryName)
    expect(entries).toContain('userdata/vfox-addons/probe@vfox.test/manifest.json')
    expect(entries).toContain('userdata/vfox-addons/probe@vfox.test/probe.js')

    const imported = await runCli(withDir('import', zip, '--name', 'Restored', '--json'))
    expect(imported.code).toBe(0)
    const restored = parseJson(imported.stdout)

    const addons = await listAddons(restored.id)
    expect(addons.find(addon => addon.source === 'vfox')).toMatchObject({
      slug: 'probe@vfox.test',
      version: '1.0.0',
    })
  })
})
