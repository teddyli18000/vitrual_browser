import { parseArgs, UsageError } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { resolveDataDir } from '../core.js'
import { createOutput, createStderrLogger } from '../output.js'

export const serveCommand: Command = {
  name: 'serve',
  summary: 'Run the VFox HTTP API (foreground)',
  usage: 'vfox serve [--port 9000] [--host 127.0.0.1] [--token <token>]',
  details:
    'Serves the same API the desktop app starts in-process: REST under /api/v1, SSE at ' +
    '/api/v1/events and MCP over Streamable HTTP at /mcp. Without --token the token is read from ' +
    '<data-dir>/api-token, and generated there on first run.',
  flags: [
    ...GLOBAL_FLAGS,
    { name: 'port', kind: 'string', description: 'Port to bind (default 9000)' },
    { name: 'host', kind: 'string', description: 'Host to bind (default 127.0.0.1)' },
    { name: 'token', kind: 'string', description: 'API token (default: <data-dir>/api-token)' },
  ],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, serveCommand.flags)
    const output = createOutput(parsed.has('json'))
    const port = parsed.get('port')
    const host = parsed.get('host')
    const token = parsed.get('token')

    if (port !== undefined && !/^\d+$/.test(port)) {
      throw new UsageError(`--port must be a number (got "${port}")`)
    }

    const { startServer } = await import('@vfox/server')
    const handle = await startServer({
      dataDir: await resolveDataDir(dataDir),
      ...(port !== undefined ? { port: Number.parseInt(port, 10) } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(token !== undefined ? { token } : {}),
      // stderr, so `--json` on stdout stays parseable.
      logger: createStderrLogger('[vfox]'),
    })

    output.result(
      { url: handle.url, host: handle.host, port: handle.port, token: handle.token },
      () => {
        output.line(`VFox API listening on ${handle.url}`)
        output.line(`token: ${handle.token}`)
        output.note('Press Ctrl+C to stop.')
      },
    )

    await new Promise<void>(resolve => {
      const stop = (): void => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })

    await handle.close()
    output.note('stopped')
    return 0
  },
}
