import { parseArgs, requirePositional } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { openCore, resolveProfile, waitForRunning } from '../core.js'
import { createOutput } from '../output.js'

function describeEndpoint(wsEndpoint: string | null): string {
  // Never invent an endpoint: the engine may be launched in a mode that exposes none.
  return wsEndpoint ?? '(none — this launch exposes no automation endpoint)'
}

export const startCommand: Command = {
  name: 'start',
  summary: 'Launch a profile',
  usage: 'vfox start <id|name> [--wait]',
  details:
    '--wait blocks until the runtime reports "running" (it resolves on the core\'s change event, ' +
    'so nothing is polled).',
  flags: [...GLOBAL_FLAGS, { name: 'wait', kind: 'boolean', description: 'Wait until the profile is running' }],
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, startCommand.flags)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      const launched = await core.runtime.launch(profile.id)
      if (parsed.has('wait') && launched.status !== 'running') {
        await waitForRunning(core, profile.id)
      }
      const runtime = core.runtime.get(profile.id)

      output.result(runtime, () => {
        output.line(`Started ${profile.name} (${profile.id}) — status ${runtime.status}`)
        output.line(`wsEndpoint: ${describeEndpoint(runtime.wsEndpoint)}`)
        output.line('Attach with playwright-core: firefox.connect(wsEndpoint)')
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

export const stopCommand: Command = {
  name: 'stop',
  summary: 'Stop a running profile',
  usage: 'vfox stop <id|name>',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, GLOBAL_FLAGS)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      const current = core.runtime.get(profile.id)
      const runtime = current.status === 'stopped' ? current : await core.runtime.stop(profile.id)
      output.result(runtime, () => {
        output.line(`Stopped ${profile.name} (${profile.id})`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}

export const openCommand: Command = {
  name: 'open',
  summary: 'Launch a profile if it is not already running',
  usage: 'vfox open <id|name>',
  flags: GLOBAL_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, GLOBAL_FLAGS)
    const output = createOutput(parsed.has('json'))
    const target = requirePositional(parsed, 0, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)
      const current = core.runtime.get(profile.id)
      if (current.status === 'stopped' || current.status === 'error') {
        const launched = await core.runtime.launch(profile.id)
        output.result(launched, () => {
          output.line(`Started ${profile.name} (${profile.id})`)
          output.line(`wsEndpoint: ${describeEndpoint(launched.wsEndpoint)}`)
        })
        return 0
      }

      output.result(current, () => {
        output.line(`${profile.name} is already ${current.status}`)
        output.line(`wsEndpoint: ${describeEndpoint(current.wsEndpoint)}`)
      })
      return 0
    } finally {
      await core.close()
    }
  },
}
