import type { SyncSession, TileRequest } from '@vfox/shared'
import { API_ROUTES, TileRequestSchema } from '@vfox/shared'

import { openApi } from '../api.js'
import type { Parsed } from '../args.js'
import { parseArgs, requirePositional, UsageError } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, resolveDataDir } from '../core.js'
import type { Output } from '../output.js'
import { createOutput } from '../output.js'

/** What a valid command line asks for. Built before any connection is opened. */
type Plan =
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'start'; master: string; slaves: string[] }
  | { kind: 'tile'; request: TileRequest }

export const syncCommand: Command = {
  name: 'sync',
  summary: 'Control the window synchroniser on a running server',
  usage: 'vfox sync start <master> <slave>... | stop | status | tile <id|name>...',
  details:
    'The session belongs to the server process, so these commands drive a running API rather ' +
    'than opening one here, where it would end with the command. Start that server with ' +
    '`vfox serve`, or use the desktop app. Connection: --url (default VFOX_API_HOST/' +
    'VFOX_API_PORT, i.e. http://127.0.0.1:9000 — pass the port `vfox serve` printed if 9000 was ' +
    'taken) and --token (default VFOX_API_TOKEN, then <data-dir>/api-token). `status` exits 1 ' +
    'when no session is active, so it can gate a script.',
  flags: [
    ...GLOBAL_FLAGS,
    { name: 'url', kind: 'string', description: 'API base URL (default http://127.0.0.1:9000)' },
    {
      name: 'token',
      kind: 'string',
      description: 'API token (default VFOX_API_TOKEN, then <data-dir>/api-token)',
    },
    { name: 'layout', kind: 'string', description: 'tile: grid | rows | columns (default grid)' },
    {
      name: 'display',
      kind: 'string',
      description: 'tile: 0-based monitor index (default primary)',
    },
  ],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, syncCommand.flags)
    const output = createOutput(parsed.has('json'))
    // Arguments first: a usage error must not depend on whether a server happens to be running.
    const plan = planOf(parsed)

    const api = await openApi({
      url: parsed.get('url'),
      token: parsed.get('token'),
      dataDir: await resolveDataDir(dataDir),
    })

    if (plan.kind === 'status') {
      return renderStatus(output, await api.get<SyncSession | null>(API_ROUTES.sync))
    }

    if (plan.kind === 'stop') {
      await api.post(API_ROUTES.syncStop)
      output.result({ ok: true }, () => {
        output.line('Sync session stopped.')
      })
      return 0
    }

    if (plan.kind === 'tile') {
      const { request } = plan
      await api.post(API_ROUTES.syncTile, request)
      const display = request.displayIndex === null ? '' : `, display ${request.displayIndex}`
      output.result({ ok: true }, () => {
        output.line(
          `Tiled ${request.profileIds.length} window(s) — layout ${request.layout}${display}`,
        )
      })
      return 0
    }

    // Ids and names both go to the API, which resolves them against the profile store exactly as
    // every other route does — the CLI must not resolve them against a possibly different store.
    const session = await api.post<SyncSession>(API_ROUTES.syncStart, {
      masterProfileId: plan.master,
      slaveProfileIds: plan.slaves,
    })
    output.result(session, () => {
      output.line(`Sync session ${session.id} started`)
      output.line(`master: ${session.masterProfileId}`)
      output.line(`slaves: ${session.slaveProfileIds.join(', ')}`)
      output.note('Input in the master window is now replayed into every slave window.')
    })
    return 0
  },
}

function planOf(parsed: Parsed): Plan {
  const action = requirePositional(parsed, 0, 'action (start, stop, status or tile)')

  if (action === 'status') return { kind: 'status' }
  if (action === 'stop') return { kind: 'stop' }

  if (action === 'start') {
    const master = requirePositional(parsed, 1, 'master profile id or name')
    const slaves = parsed.positionals.slice(2)
    if (slaves.length === 0) {
      throw new UsageError('Missing slave profile id or name (at least one is required)')
    }
    return { kind: 'start', master, slaves }
  }

  if (action === 'tile') {
    const profileIds = parsed.positionals.slice(1)
    if (profileIds.length === 0) {
      throw new UsageError('Missing profile id or name (at least one is required)')
    }
    return {
      kind: 'tile',
      request: tileRequest(profileIds, parsed.get('layout'), monitorIndex(parsed.get('display'))),
    }
  }

  throw new CliError(`Unknown sync action "${action}" — use start, stop, status or tile`)
}

/** `0` while a session is active, `1` when there is none — so `status` can gate a script. */
function renderStatus(output: Output, session: SyncSession | null): number {
  output.result(session, () => {
    if (!session) {
      output.line('No sync session is active.')
      return
    }
    output.line(`session:  ${session.id}`)
    output.line(`master:   ${session.masterProfileId}`)
    output.line(`slaves:   ${session.slaveProfileIds.join(', ')}`)
    output.line(`active:   ${session.active ? 'yes' : 'no'}`)
    output.line(`started:  ${session.startedAt ?? '-'}`)
    output.line(`mirrored: ${session.mirroredEvents} event(s)`)
  })
  return session?.active ? 0 : 1
}

/**
 * The request is built through the frozen `TileRequestSchema`, so the defaults (`grid`, the primary
 * monitor) and the accepted layouts come from the shared contract instead of being repeated here.
 */
function tileRequest(
  profileIds: string[],
  layout: string | undefined,
  displayIndex: number | null,
): TileRequest {
  const result = TileRequestSchema.safeParse({
    profileIds,
    ...(layout === undefined ? {} : { layout }),
    ...(displayIndex === null ? {} : { displayIndex }),
  })
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new UsageError(
      `Invalid tile request: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown error'}`,
    )
  }
  return result.data
}

function monitorIndex(raw: string | undefined): number | null {
  if (raw === undefined) return null
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--display must be a non-negative monitor index (got "${raw}")`)
  }
  return Number.parseInt(raw, 10)
}
