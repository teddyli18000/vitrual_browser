import type { KernelInfo, KernelProgress } from '@vfox/shared'

import { parseArgs, requirePositional, UsageError } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore } from '../core.js'
import { createOutput, type Output } from '../output.js'

const VERSION_FLAG = {
  name: 'version',
  kind: 'string' as const,
  description: 'Engine version to install (must be one this build was tested against)',
}

export const kernelCommand: Command = {
  name: 'kernel',
  summary: 'Inspect, install, remove and pin Camoufox engine kernels',
  usage:
    'vfox kernel info\n' +
    '       vfox kernel install [--version <v>]\n' +
    '       vfox kernel remove <version>\n' +
    '       vfox kernel pin <profile> <version|default>',
  details:
    'Several engine kernels can be installed side by side under <engine dir>/kernels/<version>/ and ' +
    'each profile launches with the one it is pinned to. `install` is a no-op for a version that is ' +
    'already installed, and it never changes what an existing profile runs: the engine is the ' +
    'fingerprint, so moving a profile to another build is a decision, not a side effect. `remove` ' +
    'refuses while a profile pins that kernel or a browser is running from it. Installing streams ' +
    'progress to stderr; `--json` output on stdout stays valid.',
  flags: [...GLOBAL_FLAGS, VERSION_FLAG],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, [...GLOBAL_FLAGS, VERSION_FLAG])
    const output = createOutput(parsed.has('json'))
    const action = requirePositional(parsed, 0, 'action (info, install, remove or pin)')
    if (!['info', 'install', 'remove', 'pin'].includes(action)) {
      throw new UsageError(`Unknown kernel action "${action}" — use info, install, remove or pin`)
    }

    const core = await openCore(dataDir)
    try {
      if (action === 'info') {
        const info = await core.kernel.info()
        output.result(info, () => {
          renderInfo(output, info)
        })
        return info.installed ? 0 : 1
      }

      if (action === 'install') {
        const version = parsed.get('version')
        const render = progressRenderer(output)
        const unsubscribe = core.kernel.on('progress', render)
        try {
          const info = await core.kernel.install(version)
          render({
            phase: 'done',
            percent: 100,
            receivedBytes: null,
            totalBytes: null,
            message: null,
          })
          output.result(info, () => {
            renderInfo(output, info)
          })
          return 0
        } finally {
          unsubscribe()
        }
      }

      if (action === 'remove') {
        const version = requirePositional(parsed, 1, 'kernel version to remove')
        try {
          const info = await core.kernel.remove(version)
          output.result(info, () => {
            output.line(`Kernel ${version} removed.`)
            renderInfo(output, info)
          })
          return 0
        } catch (error) {
          // The two refusals — a profile pins it, a browser is running from it — are the interesting
          // outcomes here, and they carry the profile names, so pass them through unchanged.
          throw new CliError(message(error))
        }
      }

      // pin
      const target = requirePositional(parsed, 1, 'profile id or name')
      const requested = requirePositional(parsed, 2, 'kernel version, or "default"')
      const profiles = await core.profiles.list()
      const profile = profiles.find(item => item.id === target || item.name === target)
      if (!profile) {
        throw new CliError(`Unknown profile: ${target}`)
      }

      const info = await core.kernel.info()
      const version = requested === 'default' ? info.defaultVersion : requested
      if (!version) {
        throw new CliError(
          'No default kernel is installed — run `vfox kernel install` first, or name a version.',
        )
      }
      if (!info.kernels.some(kernel => kernel.version === version && kernel.problem === null)) {
        const installed = info.kernels.map(kernel => kernel.version).join(', ') || 'none'
        throw new CliError(
          `Kernel ${version} is not installed. Installed: ${installed}. ` +
            'Run `vfox kernel info` to see them, or `vfox kernel install --version ' +
            `${version}\` to add it.`,
        )
      }

      const updated = await core.profiles.update(profile.id, { kernel: version })
      output.result(updated, () => {
        output.line(`Profile "${updated.name}" pinned to kernel ${version}.`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

/** The installed kernels, their disk cost, and how many profiles are pinned to each. */
function renderInfo(output: Output, info: KernelInfo): void {
  output.table(info.kernels, [
    { header: 'VERSION', value: kernel => kernel.version },
    { header: 'SIZE', value: kernel => formatBytes(kernel.bytes) },
    { header: 'PROFILES', value: kernel => String(kernel.profileCount) },
    { header: 'DEFAULT', value: kernel => (kernel.isDefault ? 'yes' : '') },
    {
      header: 'LOCATION',
      value: kernel => (kernel.location === 'legacy-root' ? 'engine root (legacy)' : 'kernels/'),
    },
  ])
  for (const kernel of info.kernels) {
    if (kernel.problem) {
      output.note(`[kernel] ${kernel.version} cannot be launched: ${kernel.problem}`)
    }
  }
  output.line(`total:   ${formatBytes(info.totalBytes)}`)
  output.line(`default: ${info.defaultVersion ?? '-'}`)
  output.line(`path:    ${info.path ?? '-'}`)
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
