/**
 * A real `@vfox/server` app over a fake core and a fake synchroniser, on an ephemeral loopback port.
 *
 * `vfox sync` is an HTTP client, so its tests need a server to talk to. This starts the **real**
 * routes — the same ones the GUI and the desktop app call — and stubs only the two things that
 * cannot exist in this sandbox: the browser (through the fake core) and the synchroniser session
 * (through the fake handle). The routes themselves are never faked.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApp, silentLogger } from '@vfox/server'

export const TEST_TOKEN = 'cli-sync-token-abcdef'

/** A `SyncHandle` in memory: enough for the routes, with none of the Playwright. */
function createFakeSync() {
  let session = null
  const listeners = new Set()

  const clone = () =>
    session === null ? null : { ...session, slaveProfileIds: [...session.slaveProfileIds] }
  const notify = () => {
    for (const listener of [...listeners]) listener(clone())
  }

  const fake = {
    starts: [],
    tiles: [],
    failure: undefined,

    failWith(error) {
      fake.failure = error
    },

    async start(input) {
      if (fake.failure) throw fake.failure
      fake.starts.push(input)
      session = {
        id: 'cli-session-1',
        masterProfileId: input.masterProfileId,
        slaveProfileIds: [...input.slaveProfileIds],
        active: true,
        startedAt: '2026-10-04T00:00:00.000Z',
        mirroredEvents: 3,
      }
      notify()
      return clone()
    },

    async stop() {
      session = null
      notify()
    },

    current: clone,

    async tile(request) {
      if (fake.failure) throw fake.failure
      fake.tiles.push(request)
    },

    on(_event, callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },

    async close() {
      await fake.stop()
    },
  }

  return fake
}

/** The `Core` surface these routes touch: the profile store and the SSE subscriptions. */
function createMinimalCore(dataDir) {
  const profiles = new Map([
    ['p-alpha', { id: 'p-alpha', name: 'Alpha' }],
    ['p-beta', { id: 'p-beta', name: 'Beta' }],
  ])

  return {
    dataDir,
    profiles: {
      get: async id => profiles.get(id),
      list: async () => [...profiles.values()],
    },
    runtime: {
      list: () => [...profiles.keys()].map(profileId => stopped(profileId)),
      get: profileId => stopped(profileId),
      on: () => () => {},
    },
    kernel: {
      on: () => () => {},
      info: async () => ({ installed: true, version: '146.0.1', path: null, source: 'cache' }),
    },
    close: async () => {},
  }
}

function stopped(profileId) {
  return {
    profileId,
    status: 'stopped',
    pid: null,
    wsEndpoint: null,
    startedAt: null,
    lastError: null,
  }
}

export async function startFakeApi() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-cli-sync-'))
  const core = createMinimalCore(dataDir)
  const sync = createFakeSync()
  const context = await createApp({
    core,
    token: TEST_TOKEN,
    sync,
    logger: silentLogger,
    // No keepalive timer: a stray interval would keep vitest from exiting.
    heartbeatMs: 0,
  })

  await context.app.listen({ host: '127.0.0.1', port: 0 })
  const address = context.app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    core,
    sync,
    token: TEST_TOKEN,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await context.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
