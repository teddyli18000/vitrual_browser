/**
 * MCP server — the same Core instance, exposed to MCP clients over Streamable HTTP at `/mcp`.
 *
 * Transport: **stateless**. The SDK requires a fresh transport per request in stateless mode, so a
 * request-scoped `McpServer` + transport pair is created and torn down per call. Nothing is cached
 * between requests and nothing runs when no client is talking, which keeps the "no idle process,
 * no background service" invariant.
 *
 * Auth: identical to the REST API — the same `x-vfox-token` header (or an
 * `Authorization: Bearer <same token>` for stock MCP clients), enforced by the same hook in
 * `app.ts`. A wrong token never reaches this module.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Core, CoreLogger } from '@vfox/core'
import type { Profile } from '@vfox/shared'
import { OsTargetSchema, ProxySchema } from '@vfox/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { findProfile } from './resolve.js'
import { packageVersion } from './version.js'

export const MCP_PATH = '/mcp'

const IdSchema = z.string().min(1)

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Runs `fn`, turning any throw into an MCP tool error instead of a broken JSON-RPC response. */
async function guard(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn())
  } catch (error) {
    return errorResult(error)
  }
}

export function createMcpServer(core: Core): McpServer {
  const server = new McpServer({ name: 'vfox', version: packageVersion() })

  server.registerTool(
    'list_profiles',
    {
      title: 'List profiles',
      description:
        'List every VFox profile with its current runtime status (stopped/starting/running/' +
        'stopping/error), pid and wsEndpoint.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const profiles = await core.profiles.list()
        return profiles.map(profile => ({
          profile,
          runtime: core.runtime.get(profile.id),
        }))
      }),
  )

  server.registerTool(
    'create_profile',
    {
      title: 'Create profile',
      description:
        'Create a new browser profile. `os` picks the spoofed platform; `proxy` is the upstream ' +
        'proxy the profile egresses through. The profile is a real, isolated browser data ' +
        'directory on disk.',
      inputSchema: {
        name: z.string().min(1).max(120),
        os: OsTargetSchema.optional(),
        groupId: z.string().min(1).optional(),
        notes: z.string().max(4000).optional(),
        proxy: ProxySchema.optional(),
      },
    },
    async ({ name, os, groupId, notes, proxy }) =>
      guard(() =>
        core.profiles.create({
          name,
          ...(groupId !== undefined ? { groupId } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(proxy !== undefined ? { proxy } : {}),
          ...(os !== undefined ? { fingerprint: { os } } : {}),
        }),
      ),
  )

  server.registerTool(
    'launch_profile',
    {
      title: 'Launch profile',
      description:
        'Launch a profile as a real, visible browser window and return its runtime record. ' +
        'Accepts a profile id or an exact profile name. Fails if the profile is already running.',
      inputSchema: { id: IdSchema },
    },
    async ({ id }) =>
      guard(async () => {
        const profile = await findProfile(core, id)
        return core.runtime.launch(profile.id)
      }),
  )

  server.registerTool(
    'stop_profile',
    {
      title: 'Stop profile',
      description:
        'Stop a running profile and kill its whole process tree. Accepts a profile id or an ' +
        'exact profile name. Stopping a stopped profile is a no-op.',
      inputSchema: { id: IdSchema },
    },
    async ({ id }) =>
      guard(async () => {
        const profile = await findProfile(core, id)
        const current = core.runtime.get(profile.id)
        if (current.status === 'stopped') return current
        return core.runtime.stop(profile.id)
      }),
  )

  server.registerTool(
    'get_runtime',
    {
      title: 'Get runtime status',
      description:
        "Read one profile's runtime record. `wsEndpoint`, when present, is a Playwright " +
        '(Juggler) endpoint: attach with `firefox.connect(wsEndpoint)` from playwright-core. The ' +
        'Camoufox engine has no CDP port, so there is no `debuggingPort`.',
      inputSchema: { id: IdSchema },
    },
    async ({ id }) =>
      guard(async () => {
        const profile = await findProfile(core, id)
        return core.runtime.get(profile.id)
      }),
  )

  server.registerTool(
    'clone_profile',
    {
      title: 'Clone profile',
      description:
        'Duplicate a profile: its fingerprint config and its entire isolated userdata ' +
        'directory. The copy is a fully independent profile.',
      inputSchema: { id: IdSchema, name: z.string().min(1).max(120).optional() },
    },
    async ({ id, name }) =>
      guard(async () => {
        const profile = await findProfile(core, id)
        return core.profiles.clone(profile.id, name)
      }),
  )

  server.registerTool(
    'delete_profile',
    {
      title: 'Delete profile',
      description:
        'Permanently delete a profile and its userdata directory. Refuses while the profile is ' +
        'running — stop it first.',
      inputSchema: { id: IdSchema },
    },
    async ({ id }) =>
      guard(async () => {
        const profile: Profile = await findProfile(core, id)
        const runtime = core.runtime.get(profile.id)
        if (runtime.status === 'running' || runtime.status === 'starting') {
          throw new Error(`Profile "${profile.name}" is ${runtime.status} — stop it first`)
        }
        await core.profiles.remove(profile.id)
        return { id: profile.id, removed: true }
      }),
  )

  return server
}

/**
 * Mounts the Streamable HTTP transport. The transport writes straight to the socket, so the reply
 * is hijacked; the SDK speaks JSON-RPC, not the `ApiResult` envelope.
 */
export function registerMcpRoute(app: FastifyInstance, core: Core, logger: CoreLogger): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const server = createMcpServer(core)
    const transport = new StreamableHTTPServerTransport({
      // `undefined` == stateless: no session ids, no session store, no idle state.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    reply.hijack()
    const teardown = (): void => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    }
    reply.raw.on('close', teardown)

    try {
      await server.connect(transport)
      // Fastify already parsed the JSON body; hand it over instead of re-reading the stream.
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (error) {
      logger.error('mcp request failed', error)
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error' },
          }),
        )
      }
    }
  }

  app.post(MCP_PATH, handler)
  app.get(MCP_PATH, handler)
  app.delete(MCP_PATH, handler)
}
