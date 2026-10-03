import { parseArgs } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { openCore } from '../core.js'

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Run the MCP server over stdio',
  usage: 'vfox mcp',
  details:
    'Speaks the Model Context Protocol on stdin/stdout so an MCP client can launch this command ' +
    'directly. Nothing is ever written to stdout except protocol frames — all diagnostics go to ' +
    'stderr. The same seven tools are available over Streamable HTTP at /mcp from `vfox serve`.',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    // Parsed for validation only: an unknown flag must fail rather than be ignored.
    parseArgs(argv, GLOBAL_FLAGS)
    const core = await openCore(dataDir)
    const { serveMcpStdio } = await import('@vfox/server')
    try {
      await serveMcpStdio(core)
      return 0
    } finally {
      await core.close()
    }
  },
}
