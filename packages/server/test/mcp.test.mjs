import { API_ROUTES } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MCP_PATH } from '../dist/mcp.js'
import { createHarness } from './helpers/harness.mjs'

let h

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

const TOOL_NAMES = [
  'clone_profile',
  'create_profile',
  'delete_profile',
  'get_runtime',
  'launch_profile',
  'list_profiles',
  'stop_profile',
]

async function rpc(body, headers = h.auth) {
  const res = await h.app.inject({
    method: 'POST',
    url: MCP_PATH,
    headers: { ...headers, ...MCP_HEADERS },
    payload: body,
  })
  return { statusCode: res.statusCode, body: res.json() }
}

async function createProfile(name = 'Mcp') {
  const res = await h.app.inject({
    method: 'POST',
    url: API_ROUTES.profiles,
    headers: { ...h.auth, 'content-type': 'application/json' },
    payload: { name },
  })
  return res.json().data
}

const textOf = response => JSON.parse(response.result?.content?.[0]?.text ?? 'null')

describe('MCP over Streamable HTTP', () => {
  it('rejects a request without a token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: MCP_HEADERS,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('accepts the same token through Authorization: Bearer', async () => {
    const { statusCode, body } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authorization: `Bearer ${h.token}` },
    )
    expect(statusCode).toBe(200)
    expect(body.result.tools).toHaveLength(7)
  })

  it('initializes and reports the server identity', async () => {
    const { statusCode, body } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vfox-test', version: '0.0.1' },
      },
    })
    expect(statusCode).toBe(200)
    expect(body.result.serverInfo.name).toBe('vfox')
    expect(body.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('lists exactly the seven documented tools', async () => {
    const { statusCode, body } = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    expect(statusCode).toBe(200)
    const names = body.result.tools.map(tool => tool.name).sort()
    expect(names).toEqual(TOOL_NAMES)
    for (const tool of body.result.tools) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }
  })

  it('calls list_profiles and returns profile + runtime state', async () => {
    const profile = await createProfile('Listed')
    const { statusCode, body } = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_profiles', arguments: {} },
    })
    expect(statusCode).toBe(200)
    const payload = textOf(body)
    expect(payload).toHaveLength(1)
    expect(payload[0].profile.id).toBe(profile.id)
    expect(payload[0].runtime.status).toBe('stopped')
  })

  it('drives create -> launch -> get_runtime -> stop -> clone -> delete through tools', async () => {
    const created = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'create_profile', arguments: { name: 'Toolmade', os: 'macos' } },
    })
    const profile = textOf(created.body)
    expect(profile.name).toBe('Toolmade')
    expect(profile.fingerprint.os).toBe('macos')

    const launched = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'launch_profile', arguments: { id: profile.id } },
    })
    expect(textOf(launched.body)).toMatchObject({ profileId: profile.id, status: 'running' })

    const runtime = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_runtime', arguments: { id: 'Toolmade' } },
    })
    expect(textOf(runtime.body)).toMatchObject({ profileId: profile.id, status: 'running' })

    const stopped = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'stop_profile', arguments: { id: profile.id } },
    })
    expect(textOf(stopped.body)).toMatchObject({ status: 'stopped' })

    const cloned = await rpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'clone_profile', arguments: { id: profile.id, name: 'Toolcopy' } },
    })
    expect(textOf(cloned.body)).toMatchObject({ name: 'Toolcopy' })

    const removed = await rpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'delete_profile', arguments: { id: profile.id } },
    })
    expect(removed.body.result.isError).toBeUndefined()
    expect(textOf(removed.body)).toEqual({ id: profile.id, removed: true })
  })

  it('reports tool failures as MCP errors, not broken JSON-RPC', async () => {
    const { statusCode, body } = await rpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'get_runtime', arguments: { id: 'ghost' } },
    })
    expect(statusCode).toBe(200)
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('ghost')
  })

  it('rejects a tool call with invalid arguments through the shared schema', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'create_profile', arguments: { name: '' } },
    })
    expect(body.result.isError).toBe(true)
  })

  it('keeps REST and MCP on the same core instance', async () => {
    await createProfile('Shared')
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'list_profiles', arguments: {} },
    })
    const viaMcp = textOf(body)
    const res = await h.app.inject({ method: 'GET', url: API_ROUTES.profiles, headers: h.auth })
    expect(viaMcp).toHaveLength(res.json().data.length)
  })

  it('leaves no session state behind between calls (stateless transport)', async () => {
    const first = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} })
    const second = await rpc({ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} })
    expect(first.body.result.tools).toHaveLength(7)
    expect(second.body.result.tools).toHaveLength(7)
  })
})
