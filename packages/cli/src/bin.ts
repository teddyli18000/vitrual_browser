#!/usr/bin/env node
/**
 * `vfox` entry point.
 *
 * Kept to three lines of logic: run `main`, set the exit code, never throw past this point. The
 * process is not force-exited, so a command that leaves a handle open is a bug the CLI surfaces
 * rather than hides.
 */

import { main } from './main.js'

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`vfox: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
