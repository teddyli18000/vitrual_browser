/**
 * End-to-end CLI tests: `main()` is driven in-process against a real `@vfox/core` over a throwaway
 * data directory. Only the browser-launching commands are stubbed out — the sandbox forbids the
 * piped stdio Playwright needs, so `start`/`open` are not exercised here (CI covers them).
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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
  it('reports kernel info as JSON', async () => {
    const result = await runCli(withDir('kernel', 'info', '--json'))
    // Exit code 1 simply means "not installed yet" on this machine.
    expect([0, 1]).toContain(result.code)
    const info = parseJson(result.stdout)
    expect(typeof info.installed).toBe('boolean')
    expect(['cache', 'bundled', 'missing']).toContain(info.source)
  })

  it('rejects an unknown kernel action', async () => {
    const result = await runCli(withDir('kernel', 'frobnicate'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown kernel action')
  })

  it('requires an action', async () => {
    const result = await runCli(withDir('kernel'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing action')
  })
})
