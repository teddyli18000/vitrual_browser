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
          // Three things are load-bearing here, and each was established by experiment:
          //   1. every token is quoted, the command included — an absolute path such as
          //      `C:\Program Files\nodejs\node.exe` contains a space, and so can an argument
          //      when the repository lives under `C:\Users\John Doe\…`;
          //   2. the whole line is wrapped in an extra pair of quotes, because `cmd /s` strips
          //      the FIRST and LAST quote of the string it is given — without the wrapper it
          //      strips the executable's own quotes and tries to run `C:\Program`;
          //   3. `windowsVerbatimArguments` stops Node re-escaping those quotes as `\"`.
          ['/d', '/s', '/c', `"${[command, ...args].map(quoteForCmd).join(' ')}"`],
          { cwd, stdio: 'inherit', env: process.env, windowsVerbatimArguments: true },
        )
      : spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })

  if (result.error) {
    console.error(`[run] could not start \`${command}\`: ${result.error.message}`)
    return 127
  }
  return result.status ?? 1
}
