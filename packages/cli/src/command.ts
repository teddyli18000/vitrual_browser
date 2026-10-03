import { HELP_FLAG } from './args.js'
import type { FlagDef } from './args.js'

/** Flags every command accepts. */
export const GLOBAL_FLAGS: readonly FlagDef[] = [
  HELP_FLAG,
  { name: 'json', kind: 'boolean', description: 'Machine-readable JSON on stdout' },
  {
    name: 'data-dir',
    kind: 'string',
    description: 'Profile store root (default: VFOX_DATA_DIR or %APPDATA%/vfox)',
  },
]

export interface CommandContext {
  /** Arguments after the command name. */
  readonly argv: readonly string[]
  /** Global `--data-dir` value, if given. */
  readonly dataDir: string | undefined
}

export interface Command {
  readonly name: string
  readonly summary: string
  /** One line, shown in `vfox help` and in the command's own `--help`. */
  readonly usage: string
  readonly flags: readonly FlagDef[]
  readonly details?: string
  run(context: CommandContext): Promise<number>
}
