import type { KernelProgress } from '@vfox/shared'

import { parseArgs, requirePositional } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore } from '../core.js'
import { createOutput } from '../output.js'

export const kernelCommand: Command = {
  name: 'kernel',
  summary: 'Inspect or install the Camoufox engine',
  usage: 'vfox kernel install|info',
  details:
    'The engine is ~493 MB and is fetched on first run. `install` streams progress to stderr; ' +
    '`--json` output on stdout stays valid.',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, GLOBAL_FLAGS)
    const output = createOutput(parsed.has('json'))
    const action = requirePositional(parsed, 0, 'action (install or info)')
    if (action !== 'install' && action !== 'info') {
      throw new CliError(`Unknown kernel action "${action}" — use install or info`)
    }

    const core = await openCore(dataDir)
    try {
      if (action === 'info') {
        const info = await core.kernel.info()
        output.result(info, () => {
          output.line(`installed: ${info.installed ? 'yes' : 'no'}`)
          output.line(`version:   ${info.version ?? '-'}`)
          output.line(`path:      ${info.path ?? '-'}`)
          output.line(`source:    ${info.source}`)
        })
        return info.installed ? 0 : 1
      }

      const render = progressRenderer(output)
      const unsubscribe = core.kernel.on('progress', render)
      try {
        const info = await core.kernel.install()
        render({
          phase: 'done',
          percent: 100,
          receivedBytes: null,
          totalBytes: null,
          message: null,
        })
        output.result(info, () => {
          output.line(`Kernel ${info.version ?? ''} installed at ${info.path ?? 'unknown'}`.trim())
        })
        return 0
      } finally {
        unsubscribe()
      }
    } finally {
      await core.close()
    }
  },
}

/**
 * Live progress on stderr: a single overwritten line on a terminal, one line per phase when the
 * output is redirected (so logs stay readable and stdout stays clean for `--json`).
 */
function progressRenderer(output: ReturnType<typeof createOutput>): (p: KernelProgress) => void {
  const interactive = process.stderr.isTTY === true
  let lastPhase = ''
  let lastLine = ''

  return progress => {
    const percent = progress.percent === null ? '' : ` ${progress.percent.toFixed(0)}%`
    const message = progress.message ? ` ${progress.message}` : ''
    const line = `[kernel] ${progress.phase}${percent}${message}`

    if (interactive) {
      if (line === lastLine) return
      lastLine = line
      process.stderr.write(`\r${line.padEnd(78)}`)
      if (progress.phase === 'done' || progress.phase === 'error') process.stderr.write('\n')
      return
    }

    if (progress.phase === lastPhase) return
    lastPhase = progress.phase
    output.note(line)
  }
}
