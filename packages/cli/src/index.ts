/**
 * `@vfox/cli` — the `vfox` command line tool.
 *
 * Everything is a thin wrapper over `@vfox/core`; `serve` and `mcp` delegate to `@vfox/server`.
 * This package never imports Electron and never spawns a browser of its own.
 */

export type { FlagDef, Parsed } from './args.js'
export { parseArgs, renderFlags, requirePositional, UsageError } from './args.js'
export type { Command, CommandContext } from './command.js'
export { GLOBAL_FLAGS } from './command.js'
export {
  CliError,
  openCore,
  parseProxyUrl,
  resolveDataDir,
  resolveGroup,
  resolveProfile,
  waitForRunning,
} from './core.js'
export {
  COMMANDS,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  main,
  renderCommandHelp,
  renderHelp,
} from './main.js'
export type { Column, Output } from './output.js'
export { createOutput, createStderrLogger } from './output.js'
export { packageVersion } from './version.js'
