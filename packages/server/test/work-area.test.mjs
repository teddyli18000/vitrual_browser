import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from '../dist/index.js'

let dataDir
let handle = null

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'vfox-work-area-'))
})

afterEach(async () => {
  await handle?.close()
  handle = null
  await rm(dataDir, { recursive: true, force: true })
})

/**
 * The hop, tested where it broke.
 *
 * `startServer` is the path the desktop app takes, and the work area has to survive three boundaries
 * to reach the identity: the server's options, `loadCore`, and `createCore`. It was declared on two of
 * them and dropped at the third, so the app kept sizing windows from the display the fingerprint
 * claims while `verify-window.mjs` — which calls `createCore` directly — stayed green.
 *
 * 800x600 is smaller than any display browserforge draws, so a window sized from the CLAIMED display
 * cannot satisfy these bounds. That is what makes this fail without the one-line fix rather than
 * passing by luck.
 */
describe('the work area reaching the identity', () => {
  it('sizes a profile created through the API from the work area the host supplied', async () => {
    handle = await startServer({
      dataDir,
      // An ephemeral port: a leftover listener from a failed run must not decide this test.
      port: 0,
      workArea: { width: 800, height: 600 },
    })

    const response = await fetch(`${handle.url}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ name: 'sized', fingerprint: { geoip: false } }),
    })
    expect(response.status).toBe(201)

    const body = await response.json()
    const screen = body.data.identity.fingerprint.screen

    expect(screen.outerWidth).toBeLessThanOrEqual(800)
    expect(screen.outerHeight).toBeLessThanOrEqual(600)
    expect(screen.outerWidth).toBeGreaterThan(0)
  })
})
