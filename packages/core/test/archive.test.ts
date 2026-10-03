import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importProfileZip, writeProfileZip } from '../src/archive.js'
import { Store } from '../src/store.js'

let dataDir: string
let workDir: string
let store: Store

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-archive-'))
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-archive-work-'))
  store = new Store(dataDir)
  await store.load()
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.rm(workDir, { recursive: true, force: true })
})

function insert(): Parameters<typeof importProfileZip>[2] {
  return (profile, fill) => store.insertProfile(profile, fill)
}

/** A minimal but schema-valid profile config for hand-built archives. */
function archivedProfile(name = 'Evil'): unknown {
  return {
    id: 'archived-id',
    name,
    fingerprint: {},
    launch: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
}

function writeArchive(
  zipFile: string,
  entries: Array<[string, Buffer | string]>,
  forge?: { placeholder: string; actual: string },
): void {
  const zip = new AdmZip()
  for (const [name, data] of entries) {
    zip.addFile(name, typeof data === 'string' ? Buffer.from(data) : data)
  }
  zip.writeZip(zipFile)

  if (forge) {
    // adm-zip rewrites `..` segments out of entry names when writing, so a traversal attempt can
    // only be forged by patching the raw bytes afterwards. The name appears twice (local file
    // header and central directory) and is not covered by the CRC, so a same-length replacement
    // keeps the archive structurally valid.
    if (forge.placeholder.length !== forge.actual.length) {
      throw new Error('placeholder must be the same length as the forged name')
    }
    const raw = fsSync.readFileSync(zipFile)
    const from = Buffer.from(forge.placeholder)
    const to = Buffer.from(forge.actual)
    let index = raw.indexOf(from)
    while (index !== -1) {
      to.copy(raw, index)
      index = raw.indexOf(from, index + 1)
    }
    fsSync.writeFileSync(zipFile, raw)
  }
}

async function seedProfile(name = 'Acme') {
  const profile = await store.createProfile({
    name,
    notes: 'note',
    proxy: { type: 'http', host: 'proxy.local', port: 8080, username: 'u', password: 'p' },
    fingerprint: { os: 'macos', hardwareConcurrency: 8, config: { 'navigator.maxTouchPoints': 5 } },
    launch: { headless: true, startUrl: 'https://example.com' },
  })
  await fs.mkdir(path.join(store.userDataDir(profile.id), 'storage', 'default'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(store.userDataDir(profile.id), 'storage', 'default', 'cookies.sqlite'),
    'cookie-bytes',
  )
  await fs.writeFile(path.join(store.userDataDir(profile.id), 'prefs.js'), 'user_pref();')
  return profile
}

describe('export/import round trip', () => {
  it('recreates the profile with a fresh id and the whole userdata directory', async () => {
    const source = await seedProfile()
    const zipFile = path.join(workDir, 'acme.vfox.zip')

    await writeProfileZip(source, store.userDataDir(source.id), zipFile)
    expect(await fs.readFile(zipFile).then(buffer => buffer.length)).toBeGreaterThan(0)

    const imported = await importProfileZip(zipFile, 'Imported Acme', insert())

    expect(imported.id).not.toBe(source.id)
    expect(imported.name).toBe('Imported Acme')
    expect(imported.groupId).toBeNull()
    expect(imported.createdAt).not.toBe(source.createdAt)
    expect(imported.fingerprint).toEqual(source.fingerprint)
    expect(imported.proxy).toEqual(source.proxy)
    expect(imported.launch).toEqual(source.launch)
    expect(imported.notes).toBe(source.notes)
    expect(store.getProfile(imported.id)).toEqual(imported)

    expect(await fs.readFile(path.join(store.userDataDir(imported.id), 'prefs.js'), 'utf8')).toBe(
      'user_pref();',
    )
    expect(
      await fs.readFile(
        path.join(store.userDataDir(imported.id), 'storage', 'default', 'cookies.sqlite'),
        'utf8',
      ),
    ).toBe('cookie-bytes')
  })

  it('suffixes the archived name when no name is given, and clears a foreign group', async () => {
    const group = await store.createGroup('Work')
    const source = await store.createProfile({ name: 'Acme', groupId: group.id })
    const zipFile = path.join(workDir, 'acme.vfox.zip')
    await writeProfileZip(source, store.userDataDir(source.id), zipFile)

    const imported = await importProfileZip(zipFile, '   ', insert())
    expect(imported.name).toBe('Acme (imported)')
    expect(imported.groupId).toBeNull()
  })

  it('exports a profile that was never launched', async () => {
    const source = await store.createProfile({ name: 'Fresh' })
    const zipFile = path.join(workDir, 'fresh.vfox.zip')

    await writeProfileZip(source, store.userDataDir(source.id), zipFile)
    const imported = await importProfileZip(zipFile, undefined, insert())

    expect(imported.fingerprint).toEqual(source.fingerprint)
    await expect(fs.access(store.userDataDir(imported.id))).rejects.toThrow()
  })

  it('creates the destination directory of the export', async () => {
    const source = await store.createProfile({ name: 'Acme' })
    const zipFile = path.join(workDir, 'nested', 'deep', 'acme.vfox.zip')

    await writeProfileZip(source, store.userDataDir(source.id), zipFile)
    expect((await fs.stat(zipFile)).isFile()).toBe(true)
    await expect(fs.access(`${zipFile}.part`)).rejects.toThrow()
  })

  it('refuses an oversized export with an actionable error instead of exhausting memory', async () => {
    const source = await store.createProfile({ name: 'Huge' })
    await fs.mkdir(store.userDataDir(source.id), { recursive: true })
    await fs.writeFile(path.join(store.userDataDir(source.id), 'cache.bin'), Buffer.alloc(4096))

    await expect(
      writeProfileZip(source, store.userDataDir(source.id), path.join(workDir, 'huge.zip'), {
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large to export/)
    await expect(fs.access(path.join(workDir, 'huge.zip'))).rejects.toThrow()
  })
})

describe('rejection', () => {
  it('rejects a zip that is not a VFox export and creates nothing', async () => {
    const zipFile = path.join(workDir, 'random.zip')
    writeArchive(zipFile, [['hello.txt', 'hi']])

    await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(
      /unexpected entry "hello.txt"/,
    )
    expect(store.listProfiles()).toEqual([])
    // Nothing was created at all — not even the profiles directory.
    await expect(fs.access(path.join(dataDir, 'profiles'))).rejects.toThrow()
  })

  it('rejects a zip without profile.json', async () => {
    const zipFile = path.join(workDir, 'no-config.zip')
    writeArchive(zipFile, [['userdata/prefs.js', 'x']])

    await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(
      /has no profile\.json/,
    )
    expect(store.listProfiles()).toEqual([])
  })

  it('rejects a foreign format or an unsupported version', async () => {
    for (const envelope of [
      { format: 'other-tool', version: 1, profile: archivedProfile() },
      { format: 'vfox-profile', version: 99, profile: archivedProfile() },
    ]) {
      const zipFile = path.join(workDir, 'foreign.zip')
      writeArchive(zipFile, [['profile.json', JSON.stringify(envelope)]])
      await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(
        /Not a VFox profile export|Unsupported profile archive version/,
      )
    }
    expect(store.listProfiles()).toEqual([])
  })

  it('rejects a profile config that does not validate', async () => {
    const zipFile = path.join(workDir, 'bad-config.zip')
    writeArchive(zipFile, [
      [
        'profile.json',
        JSON.stringify({ format: 'vfox-profile', version: 1, profile: { name: '' } }),
      ],
    ])

    await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(
      /Profile config inside .* is invalid/,
    )
    expect(store.listProfiles()).toEqual([])
  })

  it('rejects path traversal instead of writing outside the profile directory', async () => {
    const cases = [
      { placeholder: 'xx/escape.txt', actual: '../escape.txt' },
      { placeholder: 'xx/escape.txt', actual: '..\\escape.txt' },
      { placeholder: 'userdata/xxxxxxxxxxxxxxxx', actual: 'userdata/../../escape.txt' },
    ]
    for (const forge of cases) {
      const zipFile = path.join(workDir, 'evil.zip')
      writeArchive(
        zipFile,
        [
          [
            'profile.json',
            JSON.stringify({ format: 'vfox-profile', version: 1, profile: archivedProfile() }),
          ],
          [forge.placeholder, 'pwned'],
        ],
        forge,
      )

      await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(
        /escapes the extraction directory/,
      )
      expect(store.listProfiles()).toEqual([])
    }

    await expect(fs.access(path.join(dataDir, 'escape.txt'))).rejects.toThrow()
    await expect(fs.access(path.join(os.tmpdir(), 'escape.txt'))).rejects.toThrow()
  })

  it('rejects an absolute entry name', async () => {
    const zipFile = path.join(workDir, 'absolute.zip')
    writeArchive(zipFile, [
      [
        'profile.json',
        JSON.stringify({ format: 'vfox-profile', version: 1, profile: archivedProfile() }),
      ],
      ['userdata/C:/Windows/evil.txt', 'pwned'],
    ])

    await expect(importProfileZip(zipFile, undefined, insert())).rejects.toThrow(/absolute path/)
    expect(store.listProfiles()).toEqual([])
  })

  it('reports a missing archive and a non-zip file clearly', async () => {
    await expect(
      importProfileZip(path.join(workDir, 'nope.zip'), undefined, insert()),
    ).rejects.toThrow(/archive not found/)

    const notAZip = path.join(workDir, 'not-a-zip.zip')
    await fs.writeFile(notAZip, 'definitely not a zip')
    await expect(importProfileZip(notAZip, undefined, insert())).rejects.toThrow(
      /Not a readable zip archive/,
    )
  })
})
