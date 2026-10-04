/**
 * `GET|POST /api/v1/profiles/:id/cookies/{export,import}`.
 *
 * The format and the SQLite jar belong to `@vfox/core` and are tested there. What matters at this
 * layer is the HTTP contract: raw bytes with a download filename on the way out, the envelope on
 * the way in, and the 409 that keeps a running browser from having its cookie store written
 * underneath it.
 */

import { API_ROUTES } from '@vfox/shared'
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

async function createProfile(name = 'Cookies') {
  const res = await h.app.inject({
    method: 'POST',
    url: API_ROUTES.profiles,
    headers: { ...h.auth, ...json },
    payload: { name },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id
}

const SAMPLE = [
  '# Netscape HTTP Cookie File',
  '.shop.test\tTRUE\t/\tFALSE\t1900000000\tsid\tsession-value',
  '.shop.test\tTRUE\t/\tTRUE\t0\ttoken\tsecret',
  '',
].join('\n')

describe('GET /profiles/:id/cookies/export', () => {
  it('answers with raw text/plain, not the envelope', async () => {
    const id = await createProfile('Exported')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies(id),
      headers: h.auth,
    })

    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/plain')
    expect(String(res.headers['content-disposition'])).toContain('Exported.cookies.txt')
    expect(res.body).toBe(h.core.cookieExport.content)
    expect(h.core.cookieExports).toEqual([id])
    // The body is a cookies.txt file, so nothing may wrap it in JSON.
    expect(() => res.json()).toThrow()
  })

  it('accepts a profile name, like every other profile route', async () => {
    await createProfile('ByName')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies('ByName'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
  })

  it('404s an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies('ghost'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
    expect(h.core.cookieExports).toEqual([])
  })

  it('409s a running profile and never reads the jar', async () => {
    const id = await createProfile('Running')
    h.core.setRuntime(id, { status: 'running', pid: 99 })

    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies(id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')
    expect(res.json().error.message).toContain('stop it before')
    expect(h.core.cookieExports).toEqual([])
  })

  it('409s a starting profile', async () => {
    const id = await createProfile('Starting')
    h.core.setRuntime(id, { status: 'starting' })
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies(id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(409)
  })

  it('allows a profile whose last launch failed', async () => {
    const id = await createProfile('Errored')
    h.core.setRuntime(id, { status: 'error', lastError: 'boom' })
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.exportCookies(id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
  })

  it('requires the token', async () => {
    const id = await createProfile()
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.exportCookies(id) })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /profiles/:id/cookies/import', () => {
  it('merges by default and answers with the envelope', async () => {
    const id = await createProfile('Imported')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      success: true,
      data: {
        profileId: id,
        mode: 'merge',
        parsed: 2,
        written: 2,
        updated: 1,
        removed: 0,
        skipped: [],
      },
    })
    expect(h.core.cookieImports).toEqual([{ id, content: SAMPLE, mode: 'merge' }])
  })

  it('passes replace through', async () => {
    const id = await createProfile('Replaced')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE, mode: 'replace' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ mode: 'replace', removed: 7 })
  })

  it('409s a running profile and writes nothing', async () => {
    const id = await createProfile('Busy')
    h.core.setRuntime(id, { status: 'running', pid: 42 })

    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE },
    })
    expect(res.statusCode).toBe(409)
    expect(h.core.cookieImports).toEqual([])
  })

  it('rejects a body without content', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { mode: 'merge' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })

  it('rejects an unknown mode', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE, mode: 'overwrite' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })

  it('refuses a text/plain body, which a cross-site form could send', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, 'content-type': 'text/plain' },
      payload: SAMPLE,
    })
    expect(res.statusCode).toBe(415)
    expect(h.core.cookieImports).toEqual([])
  })

  it('404s an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies('ghost'),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE },
    })
    expect(res.statusCode).toBe(404)
  })

  it('surfaces a core failure as a 500 rather than a silent success', async () => {
    const id = await createProfile()
    h.core.cookieImportError = new Error('no cookie store yet')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.importCookies(id),
      headers: { ...h.auth, ...json },
      payload: { content: SAMPLE },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.message).toContain('no cookie store yet')
  })
})
