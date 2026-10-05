/**
 * `GET|POST /api/v1/profiles/:id/addons` and `DELETE .../addons/:slug`.
 *
 * The store itself — extracting an `.xpi`, refusing a zip-slip, the atomic swap — belongs to
 * `@vfox/core` and is tested there. What matters at this layer is the HTTP contract: the envelope,
 * the local `path` body, the 409 that keeps the addon list from changing under a running browser,
 * and the one place this feature deliberately does *not* copy the cookie routes: a running profile
 * can still be **listed**, because the store is an inert directory nobody holds open.
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

async function createProfile(name = 'Addons') {
  const res = await h.app.inject({
    method: 'POST',
    url: API_ROUTES.profiles,
    headers: { ...h.auth, ...json },
    payload: { name },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id
}

describe('GET /profiles/:id/addons', () => {
  it('answers with the envelope, engine defaults included', async () => {
    const id = await createProfile('Listed')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profileAddons(id),
      headers: h.auth,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.map(addon => addon.slug)).toEqual(['probe@vfox.test', 'engine:UBO'])
    expect(body.data[1]).toMatchObject({ source: 'engine', name: 'uBlock Origin' })
    expect(h.core.addonLists).toEqual([id])
  })

  it('accepts a profile name, like every other profile route', async () => {
    await createProfile('ByName')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profileAddons('ByName'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(200)
  })

  it('lists a RUNNING profile, unlike the cookie routes', async () => {
    const id = await createProfile('Running')
    h.core.setRuntime(id, { status: 'running', pid: 99 })

    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profileAddons(id),
      headers: h.auth,
    })

    // The store is an inert directory on disk that no browser holds open, so disk is authoritative
    // and there is nothing for a live process to be inconsistent with. Refusing here would only
    // stop the UI from showing what a running profile carries.
    expect(res.statusCode).toBe(200)
    expect(h.core.addonLists).toEqual([id])
  })

  it('404s an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profileAddons('ghost'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
    expect(h.core.addonLists).toEqual([])
  })

  it('requires the token', async () => {
    const id = await createProfile()
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profileAddons(id) })
    expect(res.statusCode).toBe(401)
  })

  it('surfaces a core failure as a 500 rather than an empty list', async () => {
    const id = await createProfile()
    h.core.addonListError = new Error('addon store unreadable')
    const res = await h.app.inject({
      method: 'GET',
      url: API_ROUTES.profileAddons(id),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.message).toContain('addon store unreadable')
  })
})

describe('POST /profiles/:id/addons', () => {
  it('installs from a local path and answers with the record', async () => {
    const id = await createProfile('Installed')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: 'C:\\Downloads\\ublock.xpi' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      slug: 'installed@vfox.test',
      name: 'Installed addon',
      source: 'vfox',
    })
    expect(h.core.addonInstalls).toEqual([
      { id, sourcePath: 'C:\\Downloads\\ublock.xpi', replace: false },
    ])
  })

  it('passes replace through', async () => {
    const id = await createProfile('Replaced')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: '/tmp/addon', replace: true },
    })
    expect(res.statusCode).toBe(200)
    expect(h.core.addonInstalls[0]).toMatchObject({ replace: true })
  })

  it('409s a running profile and installs nothing', async () => {
    const id = await createProfile('Busy')
    h.core.setRuntime(id, { status: 'running', pid: 42 })

    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: '/tmp/addon' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')
    expect(res.json().error.message).toContain('stop it before')
    expect(h.core.addonInstalls).toEqual([])
  })

  it('409s a starting profile', async () => {
    const id = await createProfile('Starting')
    h.core.setRuntime(id, { status: 'starting' })
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: '/tmp/addon' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('allows a profile whose last launch failed', async () => {
    const id = await createProfile('Errored')
    h.core.setRuntime(id, { status: 'error', lastError: 'boom' })
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: '/tmp/addon' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a body without a path', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { replace: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_error')
  })

  it('refuses a text/plain body, which a cross-site form could send', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, 'content-type': 'text/plain' },
      payload: 'C:\\addon',
    })
    expect(res.statusCode).toBe(415)
    expect(h.core.addonInstalls).toEqual([])
  })

  it('surfaces a refused install as a 500 with the reason', async () => {
    const id = await createProfile()
    h.core.addonInstallError = new Error('No manifest.json in /tmp/addon')
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.installAddon(id),
      headers: { ...h.auth, ...json },
      payload: { path: '/tmp/addon' },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.message).toContain('No manifest.json')
  })
})

describe('DELETE /profiles/:id/addons/:slug', () => {
  it('removes by slug and answers with the record', async () => {
    const id = await createProfile('Removed')
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profileAddon(id, 'probe@vfox.test'),
      headers: h.auth,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.removed).toMatchObject({ slug: 'probe@vfox.test' })
    expect(h.core.addonRemoves).toEqual([{ id, slugOrId: 'probe@vfox.test' }])
  })

  it('round-trips a slug with a colon in it, and one with a slash', async () => {
    const id = await createProfile('Encoded')
    for (const slug of ['engine:UBO', 'weird/slug']) {
      const res = await h.app.inject({
        method: 'DELETE',
        url: API_ROUTES.profileAddon(id, slug),
        headers: h.auth,
      })
      expect(res.statusCode).toBe(200)
    }
    expect(h.core.addonRemoves.map(call => call.slugOrId)).toEqual(['engine:UBO', 'weird/slug'])
  })

  it('409s a running profile and removes nothing', async () => {
    const id = await createProfile('Busy')
    h.core.setRuntime(id, { status: 'running', pid: 7 })

    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profileAddon(id, 'probe@vfox.test'),
      headers: h.auth,
    })

    expect(res.statusCode).toBe(409)
    expect(h.core.addonRemoves).toEqual([])
  })

  it('surfaces the core refusal for an addon the engine owns', async () => {
    const id = await createProfile()
    h.core.addonRemoveError = new Error('"UBO" is provided by the engine itself')
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profileAddon(id, 'engine:UBO'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.message).toContain('provided by the engine')
  })

  it('404s an unknown profile', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profileAddon('ghost', 'probe@vfox.test'),
      headers: h.auth,
    })
    expect(res.statusCode).toBe(404)
  })

  it('requires the token', async () => {
    const id = await createProfile()
    const res = await h.app.inject({
      method: 'DELETE',
      url: API_ROUTES.profileAddon(id, 'probe@vfox.test'),
    })
    expect(res.statusCode).toBe(401)
  })
})
