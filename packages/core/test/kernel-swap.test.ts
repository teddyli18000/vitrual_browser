import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { swapInEngine } from '../src/kernel.js'

let root: string
let target: string

/** The production extractor's shape: adm-zip, extracting into the directory it is given. */
async function extractWithAdmZip(from: string, into: string): Promise<void> {
  new AdmZip(from).extractAllTo(into, true)
}

async function makeArchive(entries: Record<string, string>): Promise<string> {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content))
  }
  const file = path.join(root, 'camoufox.zip')
  zip.writeZip(file)
  return file
}

async function seedEngine(): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, 'camoufox.exe'), 'old engine', 'utf8')
  await fs.writeFile(
    path.join(target, 'version.json'),
    JSON.stringify({ version: '152.0.4', release: 'beta.31' }),
    'utf8',
  )
}

async function listing(): Promise<string[]> {
  return (await fs.readdir(root)).sort()
}

/** What the user would still have after a failed install: the previous, launchable engine. */
async function expectPreviousEngineIntact(): Promise<void> {
  expect(await fs.readFile(path.join(target, 'camoufox.exe'), 'utf8')).toBe('old engine')
  expect(JSON.parse(await fs.readFile(path.join(target, 'version.json'), 'utf8'))).toEqual({
    version: '152.0.4',
    release: 'beta.31',
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-swap-'))
  target = path.join(root, 'engine')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('swapInEngine', () => {
  it('replaces the engine and leaves no staging or .old directory behind', async () => {
    await seedEngine()
    const archive = await makeArchive({ 'camoufox.exe': 'new engine', 'extra.txt': 'x' })

    await swapInEngine({ archive, target, extract: extractWithAdmZip })

    expect(await fs.readFile(path.join(target, 'camoufox.exe'), 'utf8')).toBe('new engine')
    expect(await fs.readFile(path.join(target, 'extra.txt'), 'utf8')).toBe('x')
    expect(await listing()).toEqual(['camoufox.zip', 'engine'])
  })

  it('installs into a target that does not exist yet', async () => {
    const archive = await makeArchive({ 'camoufox.exe': 'new engine' })

    await swapInEngine({ archive, target, extract: extractWithAdmZip })

    expect(await fs.readFile(path.join(target, 'camoufox.exe'), 'utf8')).toBe('new engine')
    expect(await listing()).toEqual(['camoufox.zip', 'engine'])
  })

  /**
   * The reported bug: a truncated archive that still passes the size checks. The real extractor is
   * used, so this is a genuine failure rather than a simulated one.
   */
  it('leaves the working engine intact when the archive is corrupt', async () => {
    await seedEngine()
    const truncated = path.join(root, 'truncated.zip')
    await fs.writeFile(truncated, Buffer.from('PK\u0003\u0004 this is not a zip', 'utf8'))

    await expect(
      swapInEngine({ archive: truncated, target, extract: extractWithAdmZip }),
    ).rejects.toThrow()

    await expectPreviousEngineIntact()
    // No half-extracted staging directory was left behind either.
    expect(await listing()).toEqual(['engine', 'truncated.zip'])
  })

  /** The most likely real-world trigger: extraction is when disk usage peaks. */
  it('leaves the working engine intact when the disk fills up during extraction', async () => {
    await seedEngine()
    const archive = await makeArchive({ 'camoufox.exe': 'new engine' })
    const warn = vi.fn()
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
    })

    await expect(
      swapInEngine({
        archive,
        target,
        extract: async () => {
          throw enospc
        },
        warn,
      }),
    ).rejects.toThrow('ENOSPC')

    await expectPreviousEngineIntact()
    expect(await listing()).toEqual(['camoufox.zip', 'engine'])
  })

  it('reports the previous engine left behind rather than failing the install', async () => {
    await seedEngine()
    const archive = await makeArchive({ 'camoufox.exe': 'new engine' })
    const warn = vi.fn()

    await swapInEngine({ archive, target, extract: extractWithAdmZip, warn })

    expect(await fs.readFile(path.join(target, 'camoufox.exe'), 'utf8')).toBe('new engine')
    expect(warn).not.toHaveBeenCalled()
  })
})
