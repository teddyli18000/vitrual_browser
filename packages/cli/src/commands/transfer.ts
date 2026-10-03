import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { parseArgs, requirePositional } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore, resolveProfile } from '../core.js'
import { createOutput } from '../output.js'

/**
 * Export/import go straight through `core.profiles.exportZip` / `importZip`. The zip format — what
 * goes in, how the config is embedded, how names collide — is the core's business, so the CLI, the
 * HTTP API and the GUI all produce byte-identical archives instead of three drifting variants.
 * That is also why this package carries no zip code of its own.
 */
export const exportCommand: Command = {
  name: 'export',
  summary: 'Export a profile (config + browser data) to a zip',
  usage: 'vfox export <id|name> <file.zip>',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, GLOBAL_FLAGS)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')
    const file = path.resolve(requirePositional(parsed, 1, 'destination zip path'))

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      await mkdir(path.dirname(file), { recursive: true })
      await core.profiles.exportZip(profile.id, file)
      const { size } = await stat(file)

      output.result({ profileId: profile.id, name: profile.name, file, bytes: size }, () => {
        output.line(`Exported ${profile.name} (${profile.id}) -> ${file} (${formatBytes(size)})`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

const IMPORT_FLAGS = [
  ...GLOBAL_FLAGS,
  { name: 'name', kind: 'string', description: 'Name for the imported profile' },
] as const

export const importCommand: Command = {
  name: 'import',
  summary: 'Create a profile from an exported zip',
  usage: 'vfox import <file.zip> [--name <new name>]',
  flags: IMPORT_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, IMPORT_FLAGS)
    const output = createOutput(parsed.has('json'))
    const file = path.resolve(requirePositional(parsed, 0, 'zip path'))

    if (!existsSync(file)) throw new CliError(`File not found: ${file}`)

    const core = await openCore(dataDir)
    try {
      const profile = await core.profiles.importZip(file, parsed.get('name'))
      output.result(profile, () => {
        output.line(`Imported ${file} -> ${profile.name} (${profile.id})`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
