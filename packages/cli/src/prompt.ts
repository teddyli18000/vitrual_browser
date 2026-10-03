import { createInterface } from 'node:readline/promises'

import { CliError } from './core.js'

/**
 * Confirmation for destructive commands.
 *
 * The only interactive prompt in the CLI, and it never runs unattended: when stdin is not a
 * terminal (a script, CI, a pipe) it refuses and tells the caller to pass `--yes` instead of
 * blocking forever on a prompt nobody can answer.
 */
export async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new CliError('Refusing to continue without confirmation: stdin is not a terminal. Re-run with --yes.')
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
