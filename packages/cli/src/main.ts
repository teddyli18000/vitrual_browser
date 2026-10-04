/**
 * `vfox` command dispatch.
 *
 * Deliberately tiny: resolve the command, parse its flags, run it, map the outcome onto an exit
 * code (0 ok, 1 runtime failure, 2 usage error). No command framework, no plugin loader, no
 * telemetry and no update check.
 */

import { parseArgs, renderFlags, UsageError } from './args.js'
import type { Command } from './command.js'
import { GLOBAL_FLAGS } from './command.js'
import { cookiesCommand } from './commands/cookies.js'
import { kernelCommand } from './commands/kernel.js'
import { mcpCommand } from './commands/mcp.js'
import { cloneCommand, createCommand, listCommand, rmCommand } from './commands/profiles.js'
import { openCommand, startCommand, stopCommand } from './commands/runtime.js'
import { serveCommand } from './commands/serve.js'
import { exportCommand, importCommand } from './commands/transfer.js'
import { CliError } from './core.js'
import { packageVersion } from './version.js'

export const COMMANDS: readonly Command[] = [
  serveCommand,
  listCommand,
  createCommand,
  startCommand,
  stopCommand,
  openCommand,
  rmCommand,
  cloneCommand,
  exportCommand,
  importCommand,
  cookiesCommand,
  kernelCommand,
  mcpCommand,
]

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export function renderHelp(): string {
  const width = Math.max(...COMMANDS.map(command => command.usage.length))
  return [
    `vfox ${packageVersion()} — anti-detect browser manager (Camoufox engine)`,
    '',
    'Usage: vfox <command> [options]',
    '',
    ...COMMANDS.map(command => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    '',
    'Global options:',
    renderFlags(GLOBAL_FLAGS),
    '',
    "Run 'vfox <command> --help' for a command's options.",
  ].join('\n')
}

export function renderCommandHelp(command: Command): string {
  return [
    command.usage,
    '',
    command.summary,
    ...(command.details ? ['', command.details] : []),
    ...(command.flags.length > 0 ? ['', 'Options:', renderFlags(command.flags)] : []),
  ].join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(`${renderHelp()}\n`)
    return name === undefined ? EXIT_USAGE : EXIT_OK
  }
  if (name === '--version' || name === '-v') {
    process.stdout.write(`${packageVersion()}\n`)
    return EXIT_OK
  }

  const command = COMMANDS.find(candidate => candidate.name === name)
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n\n${renderHelp()}\n`)
    return EXIT_USAGE
  }

  try {
    const probe = parseArgs(rest, command.flags)
    if (probe.has('help')) {
      process.stdout.write(`${renderCommandHelp(command)}\n`)
      return EXIT_OK
    }
    return await command.run({ argv: rest, dataDir: probe.get('data-dir') })
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${renderCommandHelp(command)}\n`)
      return EXIT_USAGE
    }
    if (error instanceof CliError) {
      process.stderr.write(`vfox: ${error.message}\n`)
      return EXIT_FAILURE
    }
    process.stderr.write(`vfox: ${error instanceof Error ? error.message : String(error)}\n`)
    if (process.env.VFOX_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`)
    }
    return EXIT_FAILURE
  }
}
