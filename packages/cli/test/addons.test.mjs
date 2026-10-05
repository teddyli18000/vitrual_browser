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
  it('prints a table, and says so when the profile has none of its own', async () => {
    await createProfile()
    const result = await runCli(withDir('addons', 'list', 'Alpha'))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('SLUG')
    expect(result.stderr).toContain('no addons of its own')
  })

  it('shows the engine’s own addons as read-only when the engine is installed', async () => {
    await createProfile()
    await runCli(withDir('addons', 'add', 'Alpha', await writeAddon('Mine')))

    const addons = await listAddons()
    const engine = addons.filter(addon => addon.source === 'engine')
    // The engine ships uBlock Origin and camoufox-js loads it on every launch. Where there is no
    // engine on the machine (the Linux validate job), there is nothing to report.
    if (engine.length > 0) {
      expect(engine.map(addon => addon.slug)).toContain('engine:UBO')
      const human = await runCli(withDir('addons', 'list', 'Alpha'))
      expect(human.stderr).toContain('come from the engine itself')
    }
    expect(addons.map(addon => addon.slug)).toContain('probe@vfox.test')
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
    const entries = new AdmZip(zip)
      .getEntries()
      .map(entry => entry.entryName)
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
