/**
 * run-command.mjs — run a child command with inherited stdio and report its exit status.
 *
 * Two details make this worth sharing rather than inlining:
 *
 *  - `stdio: 'inherit'` is required, not cosmetic. A child process with piped stdio cannot be
 *    created in this project's development sandbox, so `pipe` would make every script here
 *    CI-only. Inheriting the parent's streams also keeps live progress in the CI log.
 *  - On Windows, `pnpm` and friends are `.cmd` shims, which `CreateProcess` cannot execute
 *    directly. cmd.exe has no argv, so the whole line is re-parsed and each argument has to be
 *    quoted for it by hand.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

/** @param {string} arg @returns {string} */
function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} the exit status; 127 when the command could not be started at all
 */
export function run(command, args, cwd) {
  console.error(`$ ${[command, ...args].join(' ')}`)
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', [command, ...args.map(quoteForCmd)].join(' ')],
          { cwd, stdio: 'inherit', env: process.env },
        )
      : spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })

  if (result.error) {
    console.error(`[run] could not start \`${command}\`: ${result.error.message}`)
    return 127
  }
  return result.status ?? 1
}
