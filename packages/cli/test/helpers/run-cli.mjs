/**
 * Runs the CLI in-process with stdout/stderr captured.
 *
 * The sandbox denies the piped stdio a spawned child needs, so the tests call `main()` directly
 * rather than shelling out to `dist/bin.js`. That also makes assertions on exit codes exact.
 */

import { main } from '../../dist/main.js'

export async function runCli(argv) {
  const out = []
  const err = []
  const originalOut = process.stdout.write
  const originalErr = process.stderr.write

  process.stdout.write = chunk => {
    out.push(String(chunk))
    return true
  }
  process.stderr.write = chunk => {
    err.push(String(chunk))
    return true
  }

  try {
    const code = await main(argv)
    return { code, stdout: out.join(''), stderr: err.join('') }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

export function parseJson(stdout) {
  return JSON.parse(stdout)
}
