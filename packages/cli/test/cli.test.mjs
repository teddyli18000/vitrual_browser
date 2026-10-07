/**
 * End-to-end CLI tests: `main()` is driven in-process against a real `@vfox/core` over a throwaway
 * data directory. Only the browser-launching commands are stubbed out — the sandbox forbids the
 * piped stdio Playwright needs, so `start`/`open` are not exercised here (CI covers them).
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseJson, runCli } from './helpers/run-cli.mjs'

let dataDir

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-cli-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** Every command accepts the global `--data-dir`. */
const withDir = (...args) => [...args, '--data-dir', dataDir]

describe('vfox (no command)', () => {
  it('prints help and exits 2', async () => {
    const result = await runCli([])
    expect(result.code).toBe(2)
    expect(result.stdout).toContain('Usage: vfox <command> [options]')
  })

  it('prints help for --help and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    for (const command of [
      'serve',
      'list',
      'create',
      'start',
      'stop',
      'open',
      'rm',
      'clone',
      'export',
      'import',
      'kernel',
      'mcp',
    ]) {
      expect(result.stdout, `help must document ${command}`).toContain(`vfox ${command}`)
    }
  })

  it('prints the version', async () => {
    const result = await runCli(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects an unknown command with exit 2', async () => {
    const result = await runCli(['frobnicate'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown command: frobnicate')
  })

  it('rejects an unknown flag with exit 2', async () => {
    const result = await runCli(withDir('list', '--nope'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown option --nope')
  })

  it('shows a command help page with --help', async () => {
    const result = await runCli(['create', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('vfox create <name>')
    expect(result.stdout).toContain('--proxy')
  })
})

describe('vfox create / list', () => {
  it('creates a profile and lists it as JSON', async () => {
    const created = await runCli(withDir('create', 'Alpha', '--os', 'macos', '--json'))
    expect(created.code).toBe(0)
    const profile = parseJson(created.stdout)
    expect(profile.name).toBe('Alpha')
    expect(profile.fingerprint.os).toBe('macos')
    expect(profile.launch.headless).toBe(false)

    const listed = await runCli(withDir('list', '--json'))
    expect(listed.code).toBe(0)
    const rows = parseJson(listed.stdout)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(profile.id)
    expect(rows[0].runtime.status).toBe('stopped')
  })

  it('prints a table without --json, and keeps stdout pure JSON with it', async () => {
    await runCli(withDir('create', 'Alpha'))

    const table = await runCli(withDir('list'))
    expect(table.code).toBe(0)
    expect(table.stdout).toContain('ID')
    expect(table.stdout).toContain('STATUS')
    expect(table.stdout).toContain('Alpha')

    const json = await runCli(withDir('list', '--json'))
    expect(() => parseJson(json.stdout)).not.toThrow()
  })

  it('stores a proxy parsed from a URL', async () => {
    const created = await runCli(
      withDir('create', 'Proxied', '--proxy', 'socks5://user:secret@127.0.0.1:1080', '--json'),
    )
    expect(created.code).toBe(0)
    expect(parseJson(created.stdout).proxy).toEqual({
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      password: 'secret',
    })
  })

  it('rejects an invalid --os with exit 2', async () => {
    const result = await runCli(withDir('create', 'Bad', '--os', 'beos'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--os must be windows, macos or linux')
  })

  it('rejects an invalid --proxy with exit 2', async () => {
    const result = await runCli(withDir('create', 'Bad', '--proxy', 'ftp://x:21'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unsupported proxy scheme')
  })

  it('requires a profile name', async () => {
    const result = await runCli(withDir('create'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing profile name')
  })

  it('creates the group on demand for --group', async () => {
    const created = await runCli(withDir('create', 'Grouped', '--group', 'Work', '--json'))
    expect(created.code).toBe(0)
    const profile = parseJson(created.stdout)
    expect(profile.groupId).toBeTruthy()

    // Reusing the same group name must not create a second group.
    const second = await runCli(withDir('create', 'Grouped 2', '--group', 'Work', '--json'))
    expect(parseJson(second.stdout).groupId).toBe(profile.groupId)
  })
})

describe('vfox clone / rm', () => {
  it('clones a profile', async () => {
    await runCli(withDir('create', 'Alpha'))
    const cloned = await runCli(withDir('clone', 'Alpha', '--name', 'Beta', '--json'))
    expect(cloned.code).toBe(0)
    expect(parseJson(cloned.stdout).name).toBe('Beta')

    const listed = await runCli(withDir('list', '--json'))
    expect(parseJson(listed.stdout)).toHaveLength(2)
  })

  it('removes a profile with --yes', async () => {
    await runCli(withDir('create', 'Alpha'))
    const removed = await runCli(withDir('rm', 'Alpha', '--yes', '--json'))
    expect(removed.code).toBe(0)
    expect(parseJson(removed.stdout)).toEqual({ id: expect.any(String), removed: true })

    const listed = await runCli(withDir('list', '--json'))
    expect(parseJson(listed.stdout)).toHaveLength(0)
  })

  it('refuses to remove without --yes when stdin is not a terminal', async () => {
    await runCli(withDir('create', 'Alpha'))
    const result = await runCli(withDir('rm', 'Alpha'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--yes')

    const listed = await runCli(withDir('list', '--json'))
    expect(parseJson(listed.stdout)).toHaveLength(1)
  })

  it('fails on an unknown profile', async () => {
    const result = await runCli(withDir('rm', 'ghost', '--yes'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile: ghost')
  })
})

describe('vfox export / import', () => {
  it('round-trips a profile through a zip', async () => {
    await runCli(withDir('create', 'Alpha', '--os', 'linux'))
    const zip = path.join(dataDir, 'alpha.zip')

    const exported = await runCli(withDir('export', 'Alpha', zip, '--json'))
    expect(exported.code).toBe(0)
    expect(existsSync(zip)).toBe(true)
    expect((await stat(zip)).size).toBeGreaterThan(0)

    const imported = await runCli(withDir('import', zip, '--name', 'Restored', '--json'))
    expect(imported.code).toBe(0)
    const profile = parseJson(imported.stdout)
    expect(profile.name).toBe('Restored')

    const listed = await runCli(withDir('list', '--json'))
    expect(parseJson(listed.stdout)).toHaveLength(2)
  })

  it('fails when the zip does not exist', async () => {
    const result = await runCli(withDir('import', path.join(dataDir, 'missing.zip')))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('File not found')
  })

  it('requires a destination path', async () => {
    await runCli(withDir('create', 'Alpha'))
    const result = await runCli(withDir('export', 'Alpha'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing destination zip path')
  })
})

describe('vfox stop / open', () => {
  it('stopping a stopped profile is a no-op success', async () => {
    await runCli(withDir('create', 'Alpha'))
    const result = await runCli(withDir('stop', 'Alpha', '--json'))
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({ status: 'stopped' })
  })

  it('open fails cleanly on an unknown profile', async () => {
    const result = await runCli(withDir('open', 'ghost'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile: ghost')
  })
})

describe('vfox kernel', () => {
  /**
   * Every case pins the engine root at a directory it creates itself.
   *
   * A test that reads the machine is a coin flip: `kernel info` reports whatever engine happens to be
   * installed, so the same assertions pass locally and fail in CI — that lesson is already in
   * AGENTS.md, from this very suite. Each case therefore owns its engine root and asserts the state
   * it created.
   */
  let engineRoot
  let originalEngineDir

  beforeEach(async () => {
    engineRoot = await mkdtemp(path.join(tmpdir(), 'vfox-cli-engine-'))
    originalEngineDir = process.env.CAMOUFOX_INSTALL_DIR
    process.env.CAMOUFOX_INSTALL_DIR = engineRoot
  })

  afterEach(async () => {
    if (originalEngineDir === undefined) delete process.env.CAMOUFOX_INSTALL_DIR
    else process.env.CAMOUFOX_INSTALL_DIR = originalEngineDir
    await rm(engineRoot, { recursive: true, force: true })
  })

  /** A complete kernel build: the launcher, the version marker, and the engine's property table. */
  async function writeKernel(version, { payloadBytes = 0 } = {}) {
    const dir = path.join(engineRoot, 'kernels', version)
    await mkdir(dir, { recursive: true })
    // The launcher's name is platform-specific: hard-coding `camoufox.exe` made every fixture kernel
    // invisible on the Linux CI runner, so a build that was there looked like it had no launcher.
    await writeFile(path.join(dir, process.platform === 'win32' ? 'camoufox.exe' : 'camoufox'), 'stub')
    await writeFile(path.join(dir, 'properties.json'), '[]')
    const [number, release] = version.split('-')
    await writeFile(
      path.join(dir, 'version.json'),
      JSON.stringify({ version: number, release: release ?? '' }),
    )
    if (payloadBytes > 0) {
      await writeFile(path.join(dir, 'payload.bin'), Buffer.alloc(payloadBytes))
    }
    return dir
  }

  it('reports an empty engine root as not installed', async () => {
    const result = await runCli(withDir('kernel', 'info', '--json'))

    expect(result.code).toBe(1)
    const info = parseJson(result.stdout)
    expect(info.installed).toBe(false)
    expect(info.kernels).toEqual([])
    expect(info.totalBytes).toBe(0)
    expect(info.defaultVersion).toBeNull()
    expect(info.source).toBe('missing')
  })

  it('reports every installed kernel with its size, its profiles and the default marker', async () => {
    await writeKernel('152.0.4-beta.30', { payloadBytes: 4096 })
    await writeKernel('152.0.4-beta.28')

    const result = await runCli(withDir('kernel', 'info', '--json'))

    expect(result.code).toBe(0)
    const info = parseJson(result.stdout)
    expect(info.installed).toBe(true)
    expect(info.kernels.map(kernel => kernel.version)).toEqual([
      '152.0.4-beta.30',
      '152.0.4-beta.28',
    ])
    // The build's preferred version wins the default, and it is marked as such.
    expect(info.defaultVersion).toBe('152.0.4-beta.30')
    expect(info.kernels[0]).toMatchObject({
      location: 'kernels',
      isDefault: true,
      problem: null,
      profileCount: 0,
    })
    expect(info.kernels[0].bytes).toBeGreaterThanOrEqual(4096)
    expect(info.kernels[1].isDefault).toBe(false)
    expect(info.totalBytes).toBeGreaterThanOrEqual(4096)
    expect(info.availableVersions).toContain('152.0.4-beta.30')
  })

  it('prints the table, with the disk cost and the default', async () => {
    await writeKernel('152.0.4-beta.30', { payloadBytes: 4096 })

    const result = await runCli(withDir('kernel', 'info'))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('VERSION')
    expect(result.stdout).toContain('152.0.4-beta.30')
    expect(result.stdout).toContain('DEFAULT')
    expect(result.stdout).toContain('yes')
    expect(result.stdout).toContain('total:')
    expect(result.stdout).toContain('default: 152.0.4-beta.30')
  })

  it('rejects an unknown kernel action', async () => {
    const result = await runCli(withDir('kernel', 'frobnicate'))
    // 2, not 1: an unknown action is a usage error, exactly like the missing-action case below. The
    // two used to disagree, which is how a caller ends up branching on the wrong code.
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown kernel action')
  })

  it('requires an action', async () => {
    const result = await runCli(withDir('kernel'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing action')
  })

  it('refuses to install a version this build was not tested against', async () => {
    const result = await runCli(withDir('kernel', 'install', '--version', '156.0.1-beta.34'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not one of the versions this build was tested against')
  })

  it('refuses to remove a kernel that is not installed', async () => {
    const result = await runCli(withDir('kernel', 'remove', '152.0.4-beta.28'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not installed')
  })

  it('refuses to remove a kernel a profile is pinned to, and names the profile', async () => {
    await writeKernel('152.0.4-beta.30')
    await writeKernel('152.0.4-beta.28')
    const created = await runCli(withDir('create', 'Pinned fleet'))
    expect(created.code).toBe(0)

    const result = await runCli(withDir('kernel', 'remove', '152.0.4-beta.30'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is in use by 1 profile(s)')
    expect(result.stderr).toContain('Pinned fleet')
    expect(result.stderr).toContain('vfox kernel pin')
  })

  it('pins a profile to an installed kernel, and the profile count follows', async () => {
    await writeKernel('152.0.4-beta.30')
    await writeKernel('152.0.4-beta.28')
    await runCli(withDir('create', 'Repin target'))

    const pinned = await runCli(withDir('kernel', 'pin', 'Repin target', '152.0.4-beta.28'))
    expect(pinned.code).toBe(0)
    expect(pinned.stdout).toContain('pinned to kernel 152.0.4-beta.28')

    const info = parseJson((await runCli(withDir('kernel', 'info', '--json'))).stdout)
    expect(info.kernels.find(kernel => kernel.version === '152.0.4-beta.28').profileCount).toBe(1)
    expect(info.kernels.find(kernel => kernel.version === '152.0.4-beta.30').profileCount).toBe(0)
  })

  it('refuses to pin a profile to a kernel that is not installed', async () => {
    const created = await runCli(withDir('create', 'Pin target'))
    expect(created.code).toBe(0)

    const result = await runCli(withDir('kernel', 'pin', 'Pin target', '152.0.4-beta.28'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Kernel 152.0.4-beta.28 is not installed')
    expect(result.stderr).toContain('vfox kernel install --version 152.0.4-beta.28')
  })

  it('refuses to pin an unknown profile', async () => {
    const result = await runCli(withDir('kernel', 'pin', 'no-such-profile', 'default'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile')
  })
})
