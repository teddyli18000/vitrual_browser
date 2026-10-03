/**
 * MCP over stdio, for `vfox mcp` and for MCP clients that launch a local command.
 *
 * stdio is the transport itself, so nothing may be written to stdout while it runs: the CLI passes
 * a stderr-only logger here for exactly that reason.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Core } from '@vfox/core'

import { createMcpServer } from './mcp.js'

/** Resolves when the client closes stdin, i.e. when the session is over. */
export async function serveMcpStdio(core: Core): Promise<void> {
  const server = createMcpServer(core)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  await new Promise<void>(resolve => {
    const done = (): void => resolve()
    process.stdin.once('end', done)
    process.stdin.once('close', done)
    process.stdin.once('error', done)
  })

  await server.close()
}
