/**
 * `startServer` is the frozen in-process surface the Electron main process calls, so it is tested
 * over a real loopback socket rather than through `inject()`: the port it reports must be the port
 * that actually answers.
 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { API_ROUTES, API_TOKEN_HEADER, DEFAULT_API_HOST, DEFAULT_API_PORT } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startServer } from '../dist/app.js'
import { silentLogger } from '../dist/logger.js'
import { createFakeCore } from './helpers/fake-core.mjs'
import { tick } from './helpers/harness.mjs'

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

  it('writes a diagnostics log without ever recording the token value', async () => {
    const handle = await serve({ port: 0 })

    await fetch(`${handle.url}${API_ROUTES.profiles}`) // 401: no token
    await fetch(`${handle.url}${API_ROUTES.profiles}`, {
      headers: { [API_TOKEN_HEADER]: handle.token },
    })
    await tick(50)

    const log = await readFile(path.join(dataDir, 'logs', 'vfox.log'), 'utf8')
    expect(log).toContain(`listening on ${handle.url}`)
    expect(log).toContain('api token: present')
    expect(log).toContain(`GET ${API_ROUTES.profiles} -> 401`)
    // The token's presence is logged; its value never is.
    expect(log).not.toContain(handle.token)
  })

  it('rotates the log and keeps at most five files', async () => {
    // A tiny cap makes rotation observable in a handful of lines.
    const { createRotatingLogger } = await import('../dist/file-logger.js')
    const logger = createRotatingLogger({ dataDir, maxBytes: 200, maxFiles: 5 })
    for (let index = 0; index < 60; index += 1) logger.info(`line ${index} ${'x'.repeat(20)}`)

    const logs = (await readdir(path.join(dataDir, 'logs'))).sort()
    expect(logs).toEqual(['vfox.log', 'vfox.log.1', 'vfox.log.2', 'vfox.log.3', 'vfox.log.4'])
    expect((await stat(path.join(dataDir, 'logs', 'vfox.log'))).size).toBeLessThanOrEqual(200)
  })
})
