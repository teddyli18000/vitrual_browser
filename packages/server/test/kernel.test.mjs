/**
 * Kernel routes: the list the settings panel reads, and the two refusals a removal can produce.
 *
 * The 404/409 split is the point of this file. The GUI shows the 409 body verbatim — it names the
 * profiles that pin the kernel — so "not installed" arriving as a 409, or "in use" arriving as a 500,
 * would each produce a dialog that tells the user nothing they can act on.
 */

import { API_ROUTES } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHarness } from './helpers/harness.mjs'

let harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function post(url, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.auth,
    payload,
  })
}

describe('GET /kernel', () => {
  it('reports the installed kernels, the default and the disk cost', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: API_ROUTES.kernel,
      headers: harness.auth,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.installed).toBe(true)
    expect(body.data.defaultVersion).toBe('146.0.1')
    expect(Array.isArray(body.data.kernels)).toBe(true)
    expect(typeof body.data.totalBytes).toBe('number')
  })
})

describe('POST /kernel/install', () => {
  it('installs the preferred version when the body names none', async () => {
    const response = await post(API_ROUTES.kernelInstall, {})

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ success: true, data: { started: true } })
    expect(harness.core.installCalls).toBe(1)
    expect(harness.core.installedVersions).toEqual([null])
  })

  it('passes a named version through to the core', async () => {
    const response = await post(API_ROUTES.kernelInstall, { version: '152.0.4-beta.28' })

    expect(response.statusCode).toBe(202)
    expect(harness.core.installedVersions).toEqual(['152.0.4-beta.28'])
  })

  it('rejects a version that is not a non-empty string', async () => {
    const response = await post(API_ROUTES.kernelInstall, { version: '' })

    expect(response.statusCode).toBe(400)
    expect(response.json().success).toBe(false)
    expect(harness.core.installCalls).toBe(0)
  })
})

describe('POST /kernel/remove', () => {
  it('removes the named kernel and returns the new list', async () => {
    const response = await post(API_ROUTES.kernelRemove, { version: '152.0.4-beta.28' })

    expect(response.statusCode).toBe(200)
    expect(response.json().success).toBe(true)
    expect(harness.core.removedVersions).toEqual(['152.0.4-beta.28'])
  })

  it('answers 404 when that kernel is not installed', async () => {
    harness.core.removeError = new Error('Kernel 152.0.4-beta.28 is not installed')

    const response = await post(API_ROUTES.kernelRemove, { version: '152.0.4-beta.28' })

    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.success).toBe(false)
    expect(body.error.message).toContain('is not installed')
  })

  it('answers 409 and names the profiles when the kernel is in use', async () => {
    harness.core.removeError = new Error(
      'Kernel 152.0.4-beta.28 is in use by 2 profile(s): Shop 04, Shop 05. ' +
        'Re-pin them to another kernel first (`vfox kernel pin <profile> <version>`), or stop them.',
    )

    const response = await post(API_ROUTES.kernelRemove, { version: '152.0.4-beta.28' })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.success).toBe(false)
    // The names are the actionable part; a bare "in use" is a dialog the user cannot act on.
    expect(body.error.message).toContain('Shop 04')
    expect(body.error.message).toContain('Shop 05')
    expect(body.error.message).toContain('vfox kernel pin')
  })

  it('rejects a body with no version', async () => {
    const response = await post(API_ROUTES.kernelRemove, {})

    expect(response.statusCode).toBe(400)
    expect(harness.core.removedVersions).toEqual([])
  })
})
