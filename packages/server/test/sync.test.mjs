/**
 * The window synchroniser routes.
 *
 * Two suites, because two different things need proving:
 *
 * 1. **The routes**, driven by a fake `SyncHandle` through `createApp` — every status, every
 *    `SyncError.code` mapping and every SSE frame, with no browser anywhere near the test.
 * 2. **The wiring**, driven over a real loopback socket by `startServer` with a fake core but the
 *    **real** `createSync()` handle. Those cases are chosen so the real handle fails *before* it
 *    touches Playwright: an unknown profile, a profile that is not running, a master that is also
 *    a slave, and a tile request whose pid matches no visible window.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  API_ROUTES,
  API_TOKEN_HEADER,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  SSE_EVENT_SYNC,
} from '@vfox/shared'
import { SyncError } from '@vfox/sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startServer } from '../dist/app.js'
import { silentLogger } from '../dist/logger.js'
import { createFakeCore } from './helpers/fake-core.mjs'
import { createHarness, tick } from './helpers/harness.mjs'
import { openStream } from './helpers/sse.mjs'

/** Every `SyncErrorCode` and the HTTP status it must map onto. */
const STATUS_BY_CODE = {
  invalid_input: 400,
  unknown_profile: 404,
  not_running: 409,
  already_active: 409,
  tiling_unavailable: 501,
  closed: 503,
  attach_failed: 502,
}

describe('sync routes (fake synchroniser)', () => {
  let h

  beforeEach(async () => {
    h = await createHarness()
  })

  afterEach(async () => {
    await h.dispose()
  })

  async function createProfile(name) {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: { name },
    })
    return res.json().data
  }

  function post(url, payload) {
    return h.app.inject({
      method: 'POST',
      url,
      headers: payload === undefined ? h.auth : { ...h.auth, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload }),
    })
  }

  describe('GET /api/v1/sync', () => {
    it('answers null while no session is active', async () => {
      const res = await h.app.inject({ method: 'GET', url: API_ROUTES.sync, headers: h.auth })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: null })
    })

    it('answers the current session once one is active', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })

      const res = await h.app.inject({ method: 'GET', url: API_ROUTES.sync, headers: h.auth })
      expect(res.json().data).toMatchObject({
        id: 'fake-session-1',
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
        active: true,
      })
    })

    it('requires the token', async () => {
      const res = await h.app.inject({ method: 'GET', url: API_ROUTES.sync })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('POST /api/v1/sync/start', () => {
    it('starts a session and returns it', async () => {
      const master = await createProfile('Master')
      const first = await createProfile('Slave A')
      const second = await createProfile('Slave B')

      const res = await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [first.id, second.id],
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().data).toMatchObject({
        masterProfileId: master.id,
        slaveProfileIds: [first.id, second.id],
        active: true,
        mirroredEvents: 0,
      })
      expect(h.sync.starts).toEqual([
        { masterProfileId: master.id, slaveProfileIds: [first.id, second.id] },
      ])
    })

    it('accepts an exact profile name wherever an id is expected', async () => {
      const master = await createProfile('Master One')
      const slave = await createProfile('Slave One')

      const res = await post(API_ROUTES.syncStart, {
        masterProfileId: 'Master One',
        slaveProfileIds: ['slave one'],
      })

      expect(res.statusCode).toBe(200)
      // Only store-supplied ids may reach the synchroniser — never a client string.
      expect(h.sync.starts[0]).toEqual({
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })
    })

    it('answers 404 unknown_profile for a profile that does not exist', async () => {
      const master = await createProfile('Master')

      const res = await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: ['ghost'],
      })

      expect(res.statusCode).toBe(404)
      expect(res.json().error).toMatchObject({ code: 'unknown_profile' })
      expect(res.json().error.message).toContain('ghost')
      expect(h.sync.starts).toHaveLength(0)
    })

    it('rejects a body with no slave with 400', async () => {
      const master = await createProfile('Master')

      const res = await post(API_ROUTES.syncStart, { masterProfileId: master.id })

      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('validation_error')
    })

    it('maps every SyncError code onto its status and keeps the message', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')

      for (const [code, status] of Object.entries(STATUS_BY_CODE)) {
        h.sync.failWith(new SyncError(`the synchroniser said: ${code}`, code))

        const res = await post(API_ROUTES.syncStart, {
          masterProfileId: master.id,
          slaveProfileIds: [slave.id],
        })

        expect(res.statusCode, `${code} must be ${status}`).toBe(status)
        expect(res.json().error, code).toEqual({
          code,
          message: `the synchroniser said: ${code}`,
        })
      }

      // The failure is not sticky: clearing it lets the same route succeed again.
      h.sync.failWith(undefined)
      const recovered = await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })
      expect(recovered.statusCode).toBe(200)
    })

    it('lets an unexpected failure through as a 500 rather than inventing a status', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      h.sync.failWith(new Error('boom'))

      const res = await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })

      expect(res.statusCode).toBe(500)
      expect(res.json().error.code).toBe('internal_error')
    })

    it('does not mistake an inherited property for a synchroniser code', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      const bogus = new Error('toString is not a SyncErrorCode')
      bogus.code = 'toString'
      h.sync.failWith(bogus)

      const res = await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })

      expect(res.statusCode).toBe(500)
    })
  })

  describe('POST /api/v1/sync/stop', () => {
    it('stops the session and reports ok', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })

      const res = await post(API_ROUTES.syncStop)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: { ok: true } })
      expect(h.sync.stops).toBe(1)

      const after = await h.app.inject({ method: 'GET', url: API_ROUTES.sync, headers: h.auth })
      expect(after.json().data).toBeNull()
    })

    it('is idempotent when nothing is active', async () => {
      const first = await post(API_ROUTES.syncStop)
      const second = await post(API_ROUTES.syncStop)

      expect(first.statusCode).toBe(200)
      expect(second.json()).toEqual({ success: true, data: { ok: true } })
    })
  })

  describe('POST /api/v1/sync/tile', () => {
    it('tiles the given profiles and reports ok', async () => {
      const first = await createProfile('One')
      const second = await createProfile('Two')

      const res = await post(API_ROUTES.syncTile, { profileIds: [first.id, second.id] })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: { ok: true } })
      // The shared schema supplies the defaults; the route must not invent its own.
      expect(h.sync.tiles).toEqual([
        { profileIds: [first.id, second.id], layout: 'grid', displayIndex: null },
      ])
    })

    it('passes an explicit layout and display index through', async () => {
      const profile = await createProfile('One')

      const res = await post(API_ROUTES.syncTile, {
        profileIds: [profile.id],
        layout: 'columns',
        displayIndex: 1,
      })

      expect(res.statusCode).toBe(200)
      expect(h.sync.tiles[0]).toEqual({
        profileIds: [profile.id],
        layout: 'columns',
        displayIndex: 1,
      })
    })

    it('maps tiling_unavailable onto 501 with the synchroniser message', async () => {
      const profile = await createProfile('One')
      h.sync.failWith(
        new SyncError('window tiling is only implemented for Windows', 'tiling_unavailable'),
      )

      const res = await post(API_ROUTES.syncTile, { profileIds: [profile.id] })

      expect(res.statusCode).toBe(501)
      expect(res.json().error).toEqual({
        code: 'tiling_unavailable',
        message: 'window tiling is only implemented for Windows',
      })
    })

    it('rejects an empty profile list and an unknown profile', async () => {
      const empty = await post(API_ROUTES.syncTile, { profileIds: [] })
      expect(empty.statusCode).toBe(400)
      expect(empty.json().error.code).toBe('validation_error')

      const ghost = await post(API_ROUTES.syncTile, { profileIds: ['ghost'] })
      expect(ghost.statusCode).toBe(404)
      expect(ghost.json().error.code).toBe('unknown_profile')
    })
  })

  describe('the sync SSE event', () => {
    it('pushes the start and the stop of a session', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      const stream = await openStream(h)
      await tick()

      await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })
      await tick()
      await post(API_ROUTES.syncStop)
      await tick()

      const frames = stream.frames().filter(frame => frame.event === SSE_EVENT_SYNC)
      expect(frames).toHaveLength(2)
      expect(frames[0].data).toMatchObject({ masterProfileId: master.id, active: true })
      expect(frames[1].data).toBeNull()
      stream.close()
    })

    it('replays an active session to a late client', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })

      const stream = await openStream(h)
      await tick()

      const frames = stream.frames().filter(frame => frame.event === SSE_EVENT_SYNC)
      expect(frames).toHaveLength(1)
      expect(frames[0].data).toMatchObject({
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })
      stream.close()
    })

    it('publishes a transition the routes did not cause', async () => {
      const stream = await openStream(h)
      await tick()

      // What the real handle does when the master window closes by itself.
      h.sync.emit(null)

      const frames = stream.frames().filter(frame => frame.event === SSE_EVENT_SYNC)
      expect(frames).toHaveLength(1)
      expect(frames[0].data).toBeNull()
      stream.close()
    })

    it('does not replay a session that has already stopped', async () => {
      const master = await createProfile('Master')
      const slave = await createProfile('Slave')
      await post(API_ROUTES.syncStart, {
        masterProfileId: master.id,
        slaveProfileIds: [slave.id],
      })
      await post(API_ROUTES.syncStop)

      const stream = await openStream(h)
      await tick()

      expect(stream.frames().filter(frame => frame.event === SSE_EVENT_SYNC)).toHaveLength(0)
      stream.close()
    })
  })
})

describe('startServer wires the real synchroniser', () => {
  const TOKEN = 'sync-real-token-abcdef'
  let dataDir
  let core
  let handle

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-sync-'))
    core = createFakeCore({ dataDir })
    // An inherited override would move the port out from under the assertions below.
    delete process.env.VFOX_API_PORT
    delete process.env.VFOX_API_TOKEN
    handle = await startServer({ dataDir, port: 0, token: TOKEN, logger: silentLogger, core })
  })

  afterEach(async () => {
    await handle.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  function call(path, init = {}) {
    return fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        [API_TOKEN_HEADER]: TOKEN,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })
  }

  async function createProfile(name) {
    const res = await call(API_ROUTES.profiles, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    return (await res.json()).data
  }

  it('answers null on a fresh server', async () => {
    const res = await call(API_ROUTES.sync)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: null })
  })

  it('answers 404 unknown_profile for a profile the store does not know', async () => {
    const res = await call(API_ROUTES.syncStart, {
      method: 'POST',
      body: JSON.stringify({ masterProfileId: 'ghost', slaveProfileIds: ['ghost-2'] }),
    })

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('unknown_profile')
  })

  it('answers 409 not_running from the real runtime registry', async () => {
    const master = await createProfile('Master')
    const slave = await createProfile('Slave')

    const res = await call(API_ROUTES.syncStart, {
      method: 'POST',
      body: JSON.stringify({ masterProfileId: master.id, slaveProfileIds: [slave.id] }),
    })

    expect(res.status).toBe(409)
    const error = (await res.json()).error
    expect(error.code).toBe('not_running')
    expect(error.message).toContain('not running')
  })

  it('answers 400 invalid_input when the master is also a slave', async () => {
    const master = await createProfile('Master')

    const res = await call(API_ROUTES.syncStart, {
      method: 'POST',
      body: JSON.stringify({ masterProfileId: master.id, slaveProfileIds: [master.id] }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_input')
  })

  it('answers 501 tiling_unavailable when no window matches the pid', async () => {
    const profile = await createProfile('Master')
    // A pid no window can own: the real tiling backend then reports "no visible window matched",
    // and on a host without koffi or without Windows it reports why instead. Both are 501, and
    // neither can move a window that belongs to somebody else.
    core.setRuntime(profile.id, { status: 'running', pid: 2_147_483_647 })

    const res = await call(API_ROUTES.syncTile, {
      method: 'POST',
      body: JSON.stringify({ profileIds: [profile.id] }),
    })

    expect(res.status).toBe(501)
    const error = (await res.json()).error
    expect(error.code).toBe('tiling_unavailable')
    expect(error.message).toMatch(/window/i)
  })

  it('keeps the sync routes wired when the server falls back to an ephemeral port', async () => {
    const blocker = createServer()
    const blocked = await new Promise(resolve => {
      blocker.once('error', () => resolve(false))
      blocker.listen(DEFAULT_API_PORT, DEFAULT_API_HOST, () => resolve(true))
    })

    // Its own data directory: two rotating loggers must not share one log file.
    const fallbackDir = await mkdtemp(path.join(tmpdir(), 'vfox-sync-fallback-'))
    try {
      // Either this test owns 9000 or something else does — both force the fallback.
      expect(blocked).toBeTypeOf('boolean')
      const fallback = await startServer({
        dataDir: fallbackDir,
        token: TOKEN,
        logger: silentLogger,
        core: createFakeCore({ dataDir: fallbackDir }),
      })
      try {
        expect(fallback.port).not.toBe(DEFAULT_API_PORT)
        const auth = { [API_TOKEN_HEADER]: TOKEN }

        const status = await fetch(`${fallback.url}${API_ROUTES.sync}`, { headers: auth })
        expect(status.status).toBe(200)
        expect((await status.json()).data).toBeNull()

        const created = await fetch(`${fallback.url}${API_ROUTES.profiles}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Fallback' }),
        })
        const profile = (await created.json()).data

        const started = await fetch(`${fallback.url}${API_ROUTES.syncStart}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ masterProfileId: profile.id, slaveProfileIds: [profile.id] }),
        })
        // The second app must be driven by a synchroniser too — this is the real one answering.
        expect(started.status).toBe(400)
        expect((await started.json()).error.code).toBe('invalid_input')
      } finally {
        await fallback.close()
      }
    } finally {
      await rm(fallbackDir, { recursive: true, force: true })
      await new Promise(resolve => {
        blocker.close(() => resolve())
      })
    }
  })
})
