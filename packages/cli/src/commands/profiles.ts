import type { Profile, ProfileRuntime } from '@vfox/shared'
import { MAX_BATCH_PROFILES, OsTargetSchema } from '@vfox/shared'

import { parseArgs, requirePositional, UsageError } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore, parseProxyUrl, resolveGroup, resolveProfile } from '../core.js'
import { createOutput } from '../output.js'
import { confirm } from '../prompt.js'

interface Row {
  profile: Profile
  runtime: ProfileRuntime
  group: string
}

const COLUMNS = [
  { header: 'ID', value: (row: Row) => row.profile.id },
  { header: 'NAME', value: (row: Row) => row.profile.name },
  { header: 'GROUP', value: (row: Row) => row.group },
  { header: 'OS', value: (row: Row) => row.profile.fingerprint.os },
  {
    header: 'PROXY',
    value: (row: Row) =>
      row.profile.proxy ? `${row.profile.proxy.host}:${row.profile.proxy.port}` : '',
  },
  { header: 'STATUS', value: (row: Row) => row.runtime.status },
  { header: 'PID', value: (row: Row) => (row.runtime.pid === null ? '' : String(row.runtime.pid)) },
  { header: 'WS ENDPOINT', value: (row: Row) => row.runtime.wsEndpoint ?? '' },
]

export const listCommand: Command = {
  name: 'list',
  summary: 'List profiles with their runtime status',
  usage: 'vfox list [--json]',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, GLOBAL_FLAGS)
    const output = createOutput(parsed.has('json'))
    const core = await openCore(dataDir)
    try {
      const groups = await core.groups.list()
      const groupsById = new Map(groups.map(group => [group.id, group.name]))
      const rows: Row[] = (await core.profiles.list()).map(profile => ({
        profile,
        runtime: core.runtime.get(profile.id),
        group: profile.groupId ? (groupsById.get(profile.groupId) ?? profile.groupId) : '',
      }))

      output.result(
        rows.map(row => ({ ...row.profile, runtime: row.runtime, groupName: row.group })),
        () => output.table(rows, COLUMNS),
      )
      return 0
    } finally {
      await core.close()
    }
  },
}

export const createCommand: Command = {
  name: 'create',
  summary: 'Create a profile, or a whole batch of them',
  usage:
    'vfox create <name> [--os windows|macos|linux] [--proxy <url>] [--group <group>]\n' +
    '       vfox create --count <n> --prefix <prefix> [--os …] [--proxy …] [--group …]',
  details:
    '--proxy accepts http://, https:// or socks5:// with optional credentials, e.g. ' +
    'socks5://user:pass@127.0.0.1:1080. --group takes a group id or name and is created on ' +
    'demand.\n' +
    `--count creates that many profiles in one go, named "<prefix> 1".."<prefix> n", each with its ` +
    `own generated identity; the cap is ${MAX_BATCH_PROFILES} per batch. The batch is all or ` +
    'nothing: if anything fails, no profile is created.',
  flags: [
    ...GLOBAL_FLAGS,
    { name: 'os', kind: 'string', description: 'Spoofed platform: windows, macos or linux' },
    { name: 'proxy', kind: 'string', description: 'Upstream proxy URL' },
    { name: 'group', kind: 'string', description: 'Group id or name (created if missing)' },
    { name: 'note', kind: 'string', description: 'Free-form note' },
    { name: 'count', kind: 'string', description: 'Create this many profiles in one batch' },
    { name: 'prefix', kind: 'string', description: 'Name prefix for --count, e.g. 工作号' },
  ],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, createCommand.flags)
    const output = createOutput(parsed.has('json'))

    const osRaw = parsed.get('os')
    const os = OsTargetSchema.safeParse(osRaw ?? 'windows')
    if (!os.success) {
      throw new UsageError(`--os must be windows, macos or linux (got "${osRaw}")`)
    }

    const proxyRaw = parsed.get('proxy')
    const groupRaw = parsed.get('group')
    const note = parsed.get('note')
    const countRaw = parsed.get('count')

    const core = await openCore(dataDir)
    try {
      const group =
        groupRaw === undefined ? undefined : await resolveGroup(core, groupRaw, { create: true })
      const shared = {
        ...(group !== undefined ? { groupId: group.id } : {}),
        ...(proxyRaw !== undefined ? { proxy: parseProxyUrl(proxyRaw) } : {}),
      }

      if (countRaw !== undefined) {
        const prefix = parsed.get('prefix')
        if (prefix === undefined) {
          throw new UsageError('--prefix is required with --count, e.g. --count 20 --prefix 工作号')
        }
        const count = Number(countRaw)
        if (!Number.isInteger(count) || count < 1) {
          throw new UsageError(`--count must be a positive whole number (got "${countRaw}")`)
        }
        if (count > MAX_BATCH_PROFILES) {
          throw new UsageError(
            `--count is capped at ${MAX_BATCH_PROFILES} profiles per batch (got ${count})`,
          )
        }

        const profiles = await core.profiles.createBatch({
          count,
          namePrefix: prefix,
          fingerprint: { os: os.data },
          ...shared,
        })
        output.result(profiles, () => {
          output.line(`Created ${profiles.length} profiles`)
          for (const profile of profiles) {
            output.line(`  ${profile.name} (${profile.id})`)
          }
          if (group !== undefined) output.line(`group: ${group.name}`)
        })
        return 0
      }

      const name = requirePositional(parsed, 0, 'profile name')
      const profile = await core.profiles.create({
        name,
        fingerprint: { os: os.data },
        ...shared,
        ...(note !== undefined ? { notes: note } : {}),
      })
      output.result(profile, () => {
        output.line(`Created ${profile.name} (${profile.id})`)
        if (group !== undefined) output.line(`group: ${group.name}`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

export const rmCommand: Command = {
  name: 'rm',
  summary: 'Delete a profile and its userdata directory',
  usage: 'vfox rm <id|name> [--yes]',
  details:
    'Destructive: without --yes it asks for confirmation, and refuses when stdin is not a terminal.',
  flags: [
    ...GLOBAL_FLAGS,
    { name: 'yes', kind: 'boolean', description: 'Skip the confirmation prompt' },
  ],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, rmCommand.flags)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      const runtime = core.runtime.get(profile.id)
      if (runtime.status === 'running' || runtime.status === 'starting') {
        throw new CliError(`Profile "${profile.name}" is ${runtime.status} — stop it first`)
      }

      if (!parsed.has('yes')) {
        const ok = await confirm(
          `Delete profile "${profile.name}" (${profile.id}) and its browser data? [y/N] `,
        )
        if (!ok) {
          output.note('aborted')
          return 1
        }
      }

      await core.profiles.remove(profile.id)
      output.result({ id: profile.id, removed: true }, () => {
        output.line(`Removed ${profile.name} (${profile.id})`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

export const cloneCommand: Command = {
  name: 'clone',
  summary: 'Duplicate a profile (config + userdata)',
  usage: 'vfox clone <id|name> [--name <new name>]',
  flags: [...GLOBAL_FLAGS, { name: 'name', kind: 'string', description: 'Name for the copy' }],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, cloneCommand.flags)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')
    const name = parsed.get('name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      const clone = await core.profiles.clone(profile.id, name)
      output.result(clone, () => {
        output.line(`Cloned ${profile.name} -> ${clone.name} (${clone.id})`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}
