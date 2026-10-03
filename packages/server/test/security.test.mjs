/**
 * Loopback browser security: CORS for the renderer, the `Host` allowlist, and the content-type
 * rule that kills simple-request CSRF.
 *
 * `ui`'s `pnpm --filter @vfox/desktop smoke:api` drives the same properties over a real socket;
 * these are the unit-level counterparts.
 */

import { API_ROUTES, API_TOKEN_HEADER } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHarness } from './helpers/harness.mjs'

let h

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const json = { 'content-type': 'application/json' }
const LOOPBACK_ORIGIN = 'http://localhost:5173'

async function preflight(origin, headers = {}) {
  return h.app.inject({
    method: 'OPTIONS',
    url: API_ROUTES.profiles,
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-vfox-token',
      ...headers,
    },
  })
}

describe('CORS preflight', () => {
  it('answers OPTIONS before the token check, with the full allow list', async () => {
    const res = await preflight(LOOPBACK_ORIGIN)
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN)
    expect(res.headers['access-control-allow-methods']).toContain('PATCH')
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS')
    expect(res.headers['access-control-allow-headers']).toContain('x-vfox-token')
    expect(res.headers['access-control-allow-headers']).toContain('content-type')
    expect(res.headers['access-control-allow-headers']).toContain('authorization')
    expect(res.headers['access-control-max-age']).toBe('600')
    expect(res.headers.vary).toBe('Origin')
  })

  it('answers the packaged file:// renderer, whose origin is the literal string null', async () => {
    const res = await preflight('null')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('null')
  })

  it('reflects 127.0.0.1 dev-server origins too', async () => {
    const res = await preflight('http://127.0.0.1:5173')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173')
  })

  it('sends no CORS headers for a foreign origin', async () => {
    const res = await preflight('https://evil.example')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('still requires the token once the real request is issued', async () => {
    await preflight(LOOPBACK_ORIGIN)
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { origin: LOOPBACK_ORIGIN, ...json },
      payload: { name: 'NoToken' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('CORS on responses', () => {
  it('reflects an allowed origin on a normal response', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, origin: LOOPBACK_ORIGIN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN)
  })

  it('omits the header for a foreign origin but still serves the request', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('omits the header when there is no origin at all', async () => {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles, headers: h.auth })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('carries the header on errors, so the renderer can read the 401 body', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { origin: LOOPBACK_ORIGIN },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN)
  })

  it('carries the header on the SSE stream, which skips onSend', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.events,
      headers: { ...h.auth, origin: LOOPBACK_ORIGIN },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN)
    res.raw.res.destroy()
  })
})

describe('Host allowlist (DNS rebinding)', () => {
  it('rejects a non-loopback Host with the error envelope', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, host: 'evil.example' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden_host')
  })

  it('rejects a Host that merely contains a loopback name', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, host: 'localhost.evil.example' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('accepts loopback hosts, with and without a port, and the IPv6 form', async () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.1:9000',
      'localhost',
      'localhost:9000',
      '[::1]:9000',
    ]) {
      const res = await h.app.inject({
        method: 'GET',
        url: API_ROUTES.profiles,
        headers: { ...h.auth, host },
      })
      expect(res.statusCode, `Host: ${host}`).toBe(200)
    }
  })

  it('rejects a rebinding Host on the preflight too', async () => {
    const res = await preflight(LOOPBACK_ORIGIN, { host: 'evil.example' })
    expect(res.statusCode).toBe(403)
  })
})

describe('write content types (CSRF)', () => {
  it('rejects a form POST with 415 and the envelope', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Form',
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().error.code).toBe('unsupported_media_type')
  })

  it('rejects multipart and text/plain bodies', async () => {
    for (const contentType of ['multipart/form-data; boundary=x', 'text/plain']) {
      const res = await h.app.inject({
        method: 'POST',
        url: API_ROUTES.profiles,
        headers: { ...h.auth, 'content-type': contentType },
        payload: 'name=x',
      })
      expect(res.statusCode, contentType).toBe(415)
    }
  })

  it('rejects a JSON content type on the zip import route', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importProfile,
      headers: { ...h.auth, ...json },
      payload: { not: 'a zip' },
    })
    expect(res.statusCode).toBe(415)
  })

  it('rejects an octet-stream import, which is not an accepted zip type', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importProfile,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('PK'),
    })
    expect(res.statusCode).toBe(415)
  })

  it('accepts a bodiless write such as launch', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'NoBody' },
    })
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(created.json().data.id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
  })

  it('accepts a bodiless DELETE', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'Deletable' },
    })
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profile(created.json().data.id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('client-supplied paths', () => {
  it('never lets a traversal-shaped id escape the store', async () => {
    for (const raw of ['..%2F..%2Fetc', '..', '.', '%2Fetc%2Fpasswd', 'a%00b']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `${API_ROUTES.profiles}/${raw}`,
        headers: h.auth,
      })
      expect([400, 404], `id ${raw}`).toContain(res.statusCode)
      expect(res.statusCode).not.toBe(200)
    }
  })

  it('still resolves a profile name that is not id-shaped', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: '名字 with spaces' },
    })
    expect(created.statusCode).toBe(201)
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile('名字 with spaces'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.id).toBe(created.json().data.id)
  })
})

describe('state-changing requests from a foreign origin', () => {
  // Omitting the CORS headers only stops a browser *reading* the response — the write would already
  // have happened. Writes are therefore refused outright; reads stay served.
  const EVIL = 'https://evil.example'

  async function listProfiles() {
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles, headers: h.auth })
    return res.json().data
  }

  it('refuses POST /profiles and creates nothing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, origin: EVIL, ...json },
      payload: { name: 'Evil' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden_origin')
    expect(await listProfiles()).toHaveLength(0)
  })

  it('refuses PATCH and leaves the profile untouched', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'Original' },
    })
    const id = created.json().data.id

    const res = await h.app.inject({
      method: 'PATCH',
      url: API_ROUTES.profile(id),
      headers: { ...h.auth, origin: EVIL, ...json },
      payload: { name: 'Hijacked' },
    })
    expect(res.statusCode).toBe(403)

    const after = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profile(id),
      headers: h.auth,
    })
    expect(after.json().data.name).toBe('Original')
  })

  it('refuses DELETE and leaves the profile in place', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'Survivor' },
    })
    const id = created.json().data.id

    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profile(id),
      headers: { ...h.auth, origin: EVIL },
    })
    expect(res.statusCode).toBe(403)
    expect(await listProfiles()).toHaveLength(1)
  })

  it('refuses a bodiless write such as launch', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'Unlaunchable' },
    })
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.launchProfile(created.json().data.id),
      headers: { ...h.auth, origin: EVIL },
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows the two origins the renderer actually sends', async () => {
    for (const origin of ['null', 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      const res = await h.app.inject({
        method: 'POST',
        url: API_ROUTES.profiles,
        headers: { ...h.auth, origin, ...json },
        payload: { name: `From ${origin}` },
      })
      expect(res.statusCode, origin).toBe(201)
    }
  })

  it('leaves origin-less callers alone (curl, the CLI, MCP clients)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, ...json },
      payload: { name: 'NoOrigin' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('still serves reads from a foreign origin, just without CORS headers', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profiles,
      headers: { ...h.auth, origin: EVIL },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('auth header', () => {
  it('still rejects a wrong token with the standard envelope', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.health,
      headers: { [API_TOKEN_HEADER]: 'wrong', origin: LOOPBACK_ORIGIN },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'Missing or invalid API token' },
    })
  })
})
