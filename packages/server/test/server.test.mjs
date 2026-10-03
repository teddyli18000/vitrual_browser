/**
 * `startServer` is the frozen in-process surface the Electron main process calls, so it is tested
 * over a real loopback socket rather than through `inject()`: the port it reports must be the port
 * that actually answers.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { API_ROUTES, API_TOKEN_HEADER, DEFAULT_API_HOST, DEFAULT_API_PORT } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startServer } from '../dist/app.js'
import { silentLogger } from '../dist/logger.js'
import { createFakeCore } from './helpers/fake-core.mjs'

const TEST_TOKEN = 'start-server-token-abcdef'

let dataDir
let core
const opened = []

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-start-'))
  core = createFakeCore({ dataDir })
  // The tests decide the port explicitly; an inherited env override would make them flaky.
  delete process.env.VFOX_API_PORT
  delete process.env.VFOX_API_TOKEN
})

afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function serve(options = {}) {
  const handle = await startServer({
    dataDir,
    token: TEST_TOKEN,
    logger: silentLogger,
    core,
    ...options,
  })
  opened.push(handle)
  return handle
}

describe('startServer', () => {
  it('serves the API on a real loopback socket', async () => {
    const handle = await serve({ port: 0 })
    expect(handle.host).toBe(DEFAULT_API_HOST)
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://${DEFAULT_API_HOST}:${handle.port}`)
    expect(handle.token).toBe(TEST_TOKEN)

    const authed = await fetch(`${handle.url}${API_ROUTES.health}`, {
      headers: { [API_TOKEN_HEADER]: handle.token },
    })
    expect(authed.status).toBe(200)
    const body = await authed.json()
    expect(body.success).toBe(true)
    expect(body.data.ok).toBe(true)

    const anonymous = await fetch(`${handle.url}${API_ROUTES.health}`)
    expect(anonymous.status).toBe(401)
  })

  it('closes the HTTP server and the core together', async () => {
    const handle = await serve({ port: 0 })
    const url = handle.url
    await handle.close()
    opened.length = 0

    expect(core.closed).toBe(true)
    await expect(fetch(`${url}${API_ROUTES.health}`)).rejects.toThrow()
  })

  it('mints and persists a token when none is supplied', async () => {
    const first = await startServer({ dataDir, port: 0, logger: silentLogger, core })
    opened.push(first)
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)

    const stored = (await readFile(path.join(dataDir, 'api-token'), 'utf8')).trim()
    expect(stored).toBe(first.token)
    await first.close()
    opened.length = 0

    // A later process (the CLI, the desktop) reuses the same token.
    const second = await startServer({
      dataDir,
      port: 0,
      logger: silentLogger,
      core: createFakeCore({ dataDir }),
    })
    opened.push(second)
    expect(second.token).toBe(first.token)
  })

  it(`falls back to an ephemeral port when ${DEFAULT_API_PORT} is taken`, async () => {
    const blocker = createServer()
    const blocked = await new Promise((resolve) => {
      blocker.once('error', () => resolve(false))
      blocker.listen(DEFAULT_API_PORT, DEFAULT_API_HOST, () => resolve(true))
    })

    try {
      // Either the blocker owns 9000 or something else does — both mean the port is unavailable.
      expect(blocked).toBeTypeOf('boolean')
      const handle = await serve()
      expect(handle.port).not.toBe(DEFAULT_API_PORT)
      expect(handle.port).toBeGreaterThan(0)

      const res = await fetch(`${handle.url}${API_ROUTES.health}`, {
        headers: { [API_TOKEN_HEADER]: handle.token },
      })
      expect(res.status).toBe(200)
    } finally {
      await new Promise((resolve) => {
        blocker.close(() => resolve())
      })
    }
  })

  it('reports a failure instead of silently rebinding when an explicit port is taken', async () => {
    const first = await serve({ port: 0 })
    await expect(
      startServer({
        dataDir,
        port: first.port,
        token: TEST_TOKEN,
        logger: silentLogger,
        core: createFakeCore({ dataDir }),
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('requires a dataDir', async () => {
    await expect(startServer({ dataDir: '', logger: silentLogger, core })).rejects.toThrow(/dataDir/)
  })
})
