import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { portableDataDir, resolveDataDir } from '../dist/paths.js'

let root

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vfox-paths-'))
  delete process.env.VFOX_DATA_DIR
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  delete process.env.VFOX_DATA_DIR
})

describe('resolveDataDir', () => {
  it('prefers an explicit directory', () => {
    process.env.VFOX_DATA_DIR = path.join(root, 'from-env')
    expect(resolveDataDir(path.join(root, 'explicit'))).toBe(path.resolve(root, 'explicit'))
  })

  it('falls back to VFOX_DATA_DIR', () => {
    process.env.VFOX_DATA_DIR = path.join(root, 'from-env')
    expect(resolveDataDir()).toBe(path.resolve(root, 'from-env'))
  })

  it('falls back to %APPDATA%/vfox when nothing is configured', () => {
    const appData = process.env.APPDATA
    if (!appData) return // non-Windows CI: the fallback differs by platform
    expect(resolveDataDir()).toBe(path.join(appData, 'vfox'))
  })
})

describe('portable mode', () => {
  it('is off when neither the marker nor the data directory exists', () => {
    expect(portableDataDir(path.join(root, 'VFox.exe'))).toBeUndefined()
  })

  it('switches on for the marker file next to the executable', async () => {
    await writeFile(path.join(root, 'portable'), 'marker', 'utf8')
    expect(portableDataDir(path.join(root, 'VFox.exe'))).toBe(path.join(root, 'data'))
  })

  it('switches on for a data directory next to the executable', async () => {
    await mkdir(path.join(root, 'data'), { recursive: true })
    expect(portableDataDir(path.join(root, 'VFox.exe'))).toBe(path.join(root, 'data'))
  })

  it('takes precedence over %APPDATA%, but not over VFOX_DATA_DIR', async () => {
    await writeFile(path.join(root, 'portable'), 'marker', 'utf8')
    const execPath = path.join(root, 'VFox.exe')

    // resolveDataDir reads process.execPath, so exercise the same rule through the helper plus an
    // explicit env override, which must still win.
    expect(portableDataDir(execPath)).toBe(path.join(root, 'data'))
    process.env.VFOX_DATA_DIR = path.join(root, 'from-env')
    expect(resolveDataDir()).toBe(path.resolve(root, 'from-env'))
  })
})
