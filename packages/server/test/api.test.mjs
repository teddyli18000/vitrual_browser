import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { API_ROUTES, API_TOKEN_HEADER } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHarness, tick } from './helpers/harness.mjs'

let h

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const json = { 'content-type': 'application/json' }

async function createProfile(name = 'Alpha') {
  const res = await h.app.inject({
    method: 'POST',
    url: API_ROUTES.profiles,
    headers: { ...h.auth, ...json },
    payload: { name },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data
}

describe('route table', () => {
  // Regression guard: `API_ROUTES.launchProfile(id)` and friends run their argument through
  // `encodeURIComponent`, so registering a route with a literal `':id'` produces `/profiles/%3Aid/...`
  // — a path that never matches a request. Every helper must resolve for a real id.
  it('serves every parameterised API_ROUTES path', async () => {
    const profile = await createProfile('Routed')

    for (const url of [
      API_ROUTES.profile(profile.id),
      API_ROUTES.runtimeFor(profile.id),
      API_ROUTES.exportProfile(profile.id),
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers: h.auth })
      expect(res.statusCode, `GET ${url}`).toBe(200)
    }

    const launch = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(profile.id),
      headers: h.auth,
    })
    expect(launch.statusCode, API_ROUTES.launchProfile(profile.id)).toBe(200)

    const stop = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.stopProfile(profile.id),
      headers: h.auth,
    })
    expect(stop.statusCode, API_ROUTES.stopProfile(profile.id)).toBe(200)

    const clone = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.cloneProfile(profile.id),
      headers: { ...h.auth, ...json },
      payload: {},
    })
    expect(clone.statusCode, API_ROUTES.cloneProfile(profile.id)).toBe(201)

    const group = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.groups,
      headers: { ...h.auth, ...json },
      payload: { name: 'Routed' },
    })
    const groupId = group.json().data.id
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: API_ROUTES.group(groupId),
      headers: { ...h.auth, ...json },
      payload: { name: 'Routed 2' },
    })
    expect(renamed.statusCode, API_ROUTES.group(groupId)).toBe(200)
  })

  it('does not register a literal :id pattern', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_ROUTES.profiles}/%3Aid`,
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('health', () => {
  it('answers with the ApiResult envelope', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.health, headers: h.auth })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.ok).toBe(true)
    expect(body.data.product).toBe('VFox')
    expect(body.data.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(body.data.pid).toBe(process.pid)
    expect(body.data.kernel.installed).toBe(true)
    expect(body.data.runningProfiles).toBe(0)
  })

  it('counts running profiles', async () => {
    const profile = await createProfile()
    await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(profile.id),
      headers: h.auth,
    })
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.health, headers: h.auth })
    expect(res.json().data.runningProfiles).toBe(1)
  })
})

describe('auth', () => {
  it('rejects a request without a token', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'Missing or invalid API token' },
    })
  })

  it('rejects a wrong token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { [API_TOKEN_HEADER]: 'nope' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().success).toBe(false)
  })

  it('accepts the documented x-vfox-token header', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles, headers: h.auth })
    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
  })

  it('accepts Authorization: Bearer with the same token (MCP clients)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { authorization: `Bearer ${h.token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a wrong bearer token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('protects the SSE stream', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.events })
    expect(res.statusCode).toBe(401)
  })

  it('answers unknown paths with the envelope', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/nope', headers: h.auth })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('profiles CRUD', () => {
  it('creates, lists, reads, updates and removes', async () => {
    const created = await createProfile('Alpha')
    expect(created.name).toBe('Alpha')
    expect(created.fingerprint.os).toBe('windows')
    expect(created.launch.headless).toBe(false)

    const listed = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles, headers: h.auth })
    expect(listed.json().data).toHaveLength(1)

    const byId = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile(created.id),
      headers: h.auth,
    })
    expect(byId.json().data.id).toBe(created.id)

    // Names are accepted wherever an id is, for VirtualBrowser-style scripts.
    const byName = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile('Alpha'),
      headers: h.auth,
    })
    expect(byName.json().data.id).toBe(created.id)

    const patched = await h.app.inject({
      method: 'PATCH',
      url: API_ROUTES.profile(created.id),
      headers: { ...h.auth, ...json },
      payload: { name: 'Alpha 2', notes: 'hello' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().data.name).toBe('Alpha 2')
    expect(patched.json().data.notes).toBe('hello')

    const removed = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profile(created.id),
      headers: h.auth,
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().data).toEqual({ id: created.id, removed: true })

    const gone = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile(created.id),
      headers: h.auth,
    })
    expect(gone.statusCode).toBe(404)
    expect(gone.json().error.code).toBe('not_found')
  })

  it('rejects an invalid body with 400 and the zod issues', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('validation_error')
    expect(body.error.details.issues[0].path).toBe('name')
  })

  it('rejects an unknown fingerprint value with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'Bad', fingerprint: { os: 'beos' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })

  // Relevant to the WebGL discussion (issue #14): whatever the engine ends up reading, the API
  // layer neither drops nor rewrites a configured webgl pair — a null vendor/renderer observed by a
  // probe cannot be caused by the transport or by the shared contract.
  it('round-trips a non-null webgl pair unchanged', async () => {
    const created = await createProfile('WebGL')
    const webgl = { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce RTX 4090)' }
    const res = await h.app.inject({
      method: 'PATCH',
      url: API_ROUTES.profile(created.id),
      headers: { ...h.auth, ...json },
      payload: { fingerprint: { webgl } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.fingerprint.webgl).toEqual(webgl)
  })

  it('rejects an empty JSON body with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().success).toBe(false)
  })

  it('404s an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile('does-not-exist'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.message).toContain('does-not-exist')
  })

  it('clones a profile', async () => {
    const source = await createProfile('Alpha')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.cloneProfile(source.id),
      headers: { ...h.auth, ...json },
      payload: { name: 'Beta' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.name).toBe('Beta')
    expect(res.json().data.id).not.toBe(source.id)
  })

  it('refuses to remove a running profile', async () => {
    const profile = await createProfile()
    await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(profile.id),
      headers: h.auth,
    })
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profile(profile.id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')
  })
})

describe('launch and stop', () => {
  it('launches, reports 409 on a second launch, then stops idempotently', async () => {
    const profile = await createProfile()

    const launched = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(profile.id),
      headers: h.auth,
    })
    expect(launched.statusCode).toBe(200)
    const runtime = launched.json().data
    expect(runtime.status).toBe('running')
    expect(runtime.pid).toBe(4242)
    expect(runtime.wsEndpoint).toBe('ws://127.0.0.1:5555/playwright')

    const again = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(profile.id),
      headers: h.auth,
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toContain('already running')

    const stopped = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.stopProfile(profile.id),
      headers: h.auth,
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json().data.status).toBe('stopped')

    const stoppedAgain = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.stopProfile(profile.id),
      headers: h.auth,
    })
    expect(stoppedAgain.statusCode).toBe(200)
    expect(stoppedAgain.json().data.status).toBe('stopped')
  })

  it('404s launching an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile('ghost'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
  })

  it('exposes the runtime registry', async () => {
    const profile = await createProfile()
    const all = await h.app.inject({ method: 'GET', url: API_ROUTES.runtime, headers: h.auth })
    expect(all.json().data).toHaveLength(1)
    expect(all.json().data[0].status).toBe('stopped')

    const one = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.runtimeFor(profile.id),
      headers: h.auth,
    })
    expect(one.json().data.profileId).toBe(profile.id)

    const missing = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.runtimeFor('ghost'),
      headers: h.auth,
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('groups', () => {
  it('creates, lists, renames and removes', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.groups,
      headers: { ...h.auth, ...json },
      payload: { name: 'Work' },
    })
    expect(created.statusCode).toBe(201)
    const group = created.json().data

    const renamed = await h.app.inject({
      method: 'PATCH',
      url: API_ROUTES.group(group.id),
      headers: { ...h.auth, ...json },
      payload: { name: 'Work 2' },
    })
    expect(renamed.json().data.name).toBe('Work 2')

    const listed = await h.app.inject({ method: 'GET', url: API_ROUTES.groups, headers: h.auth })
    expect(listed.json().data).toHaveLength(1)

    const removed = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.group(group.id),
      headers: h.auth,
    })
    expect(removed.json().data.removed).toBe(true)
  })

  it('rejects a nameless group', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.groups,
      headers: { ...h.auth, ...json },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })
})

describe('VirtualBrowser-compatible aliases', () => {
  it('launchBrowser returns profileId + wsEndpoint + debuggingPort: null', async () => {
    const profile = await createProfile('VB')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: profile.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      success: true,
      data: {
        profileId: profile.id,
        wsEndpoint: 'ws://127.0.0.1:5555/playwright',
        debuggingPort: null,
      },
    })
  })

  it('accepts a profile name instead of an id', async () => {
    const profile = await createProfile('ByName')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: 'ByName' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.profileId).toBe(profile.id)
  })

  it('passes a null wsEndpoint through instead of inventing one', async () => {
    const profile = await createProfile('NoEndpoint')
    h.core.setRuntime(profile.id, { status: 'running', wsEndpoint: null })

    // Already running -> 409, exactly like the native launch route.
    const launch = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: profile.id },
    })
    expect(launch.statusCode).toBe(409)

    const closed = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.closeBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: profile.id },
    })
    expect(closed.json().data.wsEndpoint).toBeNull()
    expect(closed.json().data.debuggingPort).toBeNull()
  })

  it('rejects a launchBrowser body without an id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchBrowser,
      headers: { ...h.auth, ...json },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })

  it('closeBrowser stops the profile and returns the same shape', async () => {
    const profile = await createProfile('VB2')
    await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: profile.id },
    })
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.closeBrowser,
      headers: { ...h.auth, ...json },
      payload: { id: profile.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      profileId: profile.id,
      wsEndpoint: null,
      debuggingPort: null,
    })
  })

  it('browserList reports every profile with its status', async () => {
    const profile = await createProfile('Listed')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.browserList,
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      {
        profileId: profile.id,
        wsEndpoint: null,
        debuggingPort: null,
        status: 'stopped',
        pid: null,
      },
    ])
  })
})

describe('kernel', () => {
  it('reports the kernel info', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.kernel, headers: h.auth })
    expect(res.json().data).toEqual({
      installed: true,
      version: '146.0.1',
      path: path.join(h.dataDir, 'kernel'),
      source: 'cache',
    })
  })

  it('starts an install without blocking and 409s a second one', async () => {
    h.core.installDelayMs = 60
    const first = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.kernelInstall,
      headers: h.auth,
    })
    expect(first.statusCode).toBe(202)
    expect(first.json()).toEqual({ success: true, data: { started: true } })

    const second = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.kernelInstall,
      headers: h.auth,
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('conflict')

    await tick(120)
    expect(h.core.installCalls).toBe(1)

    const third = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.kernelInstall,
      headers: h.auth,
    })
    expect(third.statusCode).toBe(202)
    await tick(120)
    expect(h.core.installCalls).toBe(2)
  })
})

describe('export / import', () => {
  it('streams raw zip bytes with a download filename', async () => {
    const profile = await createProfile('Exported')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportProfile(profile.id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('application/zip')
    expect(String(res.headers['content-disposition'])).toContain('Exported.zip')

    const body = JSON.parse(res.rawPayload.toString('utf8'))
    expect(body.profile.id).toBe(profile.id)

    // The staging file is deleted once the response stream finishes.
    await tick(30)
    expect(await readdir(path.join(h.dataDir, 'tmp'))).toEqual([])
  })

  it('imports a zip posted as raw bytes', async () => {
    const profile = await createProfile('RoundTrip')
    const exported = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportProfile(profile.id),
      headers: h.auth,
    })

    const res = await h.app.inject({
      method: 'POST',
      url: `${API_ROUTES.importProfile}?name=Imported`,
      headers: { ...h.auth, 'content-type': 'application/zip' },
      payload: exported.rawPayload,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.name).toBe('Imported')

    // The uploaded bytes are staged on disk and removed again, whatever the outcome.
    expect(await readdir(path.join(h.dataDir, 'tmp'))).toEqual([])
  })

  it('rejects an empty import body', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importProfile,
      headers: { ...h.auth, 'content-type': 'application/zip' },
      payload: Buffer.alloc(0),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })

  it('404s exporting an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportProfile('ghost'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
  })
})
