/**
 * `vfox sync` drives the synchroniser that belongs to a *running* server, so these tests run the
 * CLI in-process against a real `@vfox/server` over a real loopback socket — only the core and the
 * sync handle are fakes. See `helpers/fake-api.mjs`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startFakeApi, TEST_TOKEN } from './helpers/fake-api.mjs'
import { parseJson, runCli } from './helpers/run-cli.mjs'

let api
let emptyDir

beforeEach(async () => {
  api = await startFakeApi()
  emptyDir = await mkdtemp(path.join(tmpdir(), 'vfox-cli-empty-'))
  // An inherited token would make the "no token" test pass for the wrong reason.
  delete process.env.VFOX_API_TOKEN
})

afterEach(async () => {
  await api.close()
  await rm(emptyDir, { recursive: true, force: true })
})

/** Every command needs the connection the CLI cannot guess from the environment in a test. */
const withApi = (...args) => [...args, '--url', api.url, '--token', TEST_TOKEN]

describe('vfox sync', () => {
  it('is documented in the help output', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('vfox sync')
  })

  it('reports that no session is active, and exits 1', async () => {
    const result = await runCli(withApi('sync', 'status'))
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('No sync session is active.')
  })

  it('prints null for --json while no session is active', async () => {
    const result = await runCli(withApi('sync', 'status', '--json'))
    expect(result.code).toBe(1)
    expect(parseJson(result.stdout)).toBeNull()
  })

  it('starts a session and reports it', async () => {
    const result = await runCli(withApi('sync', 'start', 'p-alpha', 'p-beta'))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Sync session cli-session-1 started')
    expect(result.stdout).toContain('master: p-alpha')
    expect(result.stdout).toContain('slaves: p-beta')
    expect(result.stderr).toContain('replayed into every slave window')

    const status = await runCli(withApi('sync', 'status', '--json'))
    expect(status.code).toBe(0)
    expect(parseJson(status.stdout)).toMatchObject({
      id: 'cli-session-1',
      masterProfileId: 'p-alpha',
      slaveProfileIds: ['p-beta'],
      active: true,
    })
  })

  it('lets the server resolve profile names, exactly as the other routes do', async () => {
    const result = await runCli(withApi('sync', 'start', 'Alpha', 'Beta'))

    expect(result.code).toBe(0)
    expect(api.sync.starts).toEqual([{ masterProfileId: 'p-alpha', slaveProfileIds: ['p-beta'] }])
  })

  it('prints the session for --json', async () => {
    const result = await runCli(withApi('sync', 'start', 'p-alpha', 'p-beta', '--json'))

    expect(result.code).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({
      masterProfileId: 'p-alpha',
      slaveProfileIds: ['p-beta'],
      mirroredEvents: 3,
    })
  })

  it('stops a session', async () => {
    await runCli(withApi('sync', 'start', 'p-alpha', 'p-beta'))

    const stopped = await runCli(withApi('sync', 'stop'))
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain('Sync session stopped.')

    const status = await runCli(withApi('sync', 'status'))
    expect(status.code).toBe(1)
  })

  it('tiles profiles with the shared schema defaults', async () => {
    const result = await runCli(withApi('sync', 'tile', 'p-alpha', 'p-beta'))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Tiled 2 window(s)')
    expect(result.stdout).toContain('layout grid')
    expect(api.sync.tiles).toEqual([
      { profileIds: ['p-alpha', 'p-beta'], layout: 'grid', displayIndex: null },
    ])
  })

  it('passes --layout and --display through', async () => {
    const result = await runCli(
      withApi('sync', 'tile', 'Alpha', '--layout', 'rows', '--display', '1'),
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('display 1')
    expect(api.sync.tiles).toEqual([{ profileIds: ['p-alpha'], layout: 'rows', displayIndex: 1 }])
  })

  it('rejects an unknown layout as a usage error', async () => {
    const result = await runCli(withApi('sync', 'tile', 'p-alpha', '--layout', 'diagonal'))

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Invalid tile request')
    expect(result.stderr).toContain('layout')
  })

  it('rejects tile without a profile and start without a slave', async () => {
    const tile = await runCli(withApi('sync', 'tile'))
    expect(tile.code).toBe(2)
    expect(tile.stderr).toContain('Missing profile id or name')

    const start = await runCli(withApi('sync', 'start', 'p-alpha'))
    expect(start.code).toBe(2)
    expect(start.stderr).toContain('Missing slave profile id or name')
  })

  it('reports a usage error even when no server is reachable', async () => {
    // Argument mistakes are judged locally, so they must never surface as a connection failure.
    const result = await runCli([
      'sync',
      'tile',
      'p-alpha',
      '--layout',
      'diagonal',
      '--url',
      'http://127.0.0.1:1',
      '--token',
      'x',
    ])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Invalid tile request')
    expect(result.stderr).not.toContain('Cannot reach')
  })

  it('rejects an unknown action', async () => {
    const result = await runCli(withApi('sync', 'frobnicate'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown sync action "frobnicate"')
  })

  it('reports an API error and exits 1', async () => {
    const result = await runCli(withApi('sync', 'start', 'ghost-1', 'p-beta'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile: ghost-1')
    expect(result.stdout).toBe('')
  })

  it('surfaces tiling_unavailable from the API', async () => {
    const failure = new Error('window tiling is only implemented for Windows')
    failure.code = 'tiling_unavailable'
    api.sync.failWith(failure)

    const result = await runCli(withApi('sync', 'tile', 'p-alpha'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('window tiling is only implemented for Windows')
  })

  it('explains an unreachable API instead of failing with a stack trace', async () => {
    // Port 1 on loopback refuses immediately; nothing is listening there.
    const result = await runCli(['sync', 'status', '--url', 'http://127.0.0.1:1', '--token', 'x'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Cannot reach the VFox API at http://127.0.0.1:1')
    expect(result.stderr).toContain('vfox serve')
  })

  it('explains a missing token instead of minting one', async () => {
    const result = await runCli(['sync', 'status', '--url', api.url, '--data-dir', emptyDir])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`No API token at ${path.join(emptyDir, 'api-token')}`)
  })
})
