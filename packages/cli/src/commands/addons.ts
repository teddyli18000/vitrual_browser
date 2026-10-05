import { existsSync } from 'node:fs'
import path from 'node:path'

import { parseArgs, requirePositional } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore, resolveProfile } from '../core.js'
import { createOutput } from '../output.js'

const ADDON_FLAGS = [
  ...GLOBAL_FLAGS,
  {
    name: 'replace',
    kind: 'boolean',
    description: 'Install: replace the addon already installed under the same id',
  },
] as const

/**
 * The addon workflow: put an extension into one profile, see what it carries, take one out.
 *
 * An addon is arbitrary code with the browser's privileges — the same thing a browser's own "install
 * add-on" does — and VFox does not scan or sign-check it. What it does check is structure: the
 * source is a directory with a readable `manifest.json`, or an `.xpi`/`.zip` whose entries all stay
 * inside the destination, and the caps in the shared contract. Everything goes through
 * `core.addons`, and install/remove need the profile to be stopped because the engine reads the
 * addon list when it starts.
 */
export const addonsCommand: Command = {
  name: 'addons',
  summary: "Install, list or remove a profile's browser addons",
  usage: 'vfox addons list|add|remove <id|name> [path|slug] [--replace]',
  details:
    'The engine loads an addon as an extracted directory, so `add` accepts either one of those or ' +
    'an .xpi/.zip file, which VFox extracts into the profile for you. Addons live inside the ' +
    "profile's own data directory, so they travel with `vfox clone`, `vfox export` and " +
    '`vfox import`. A profile also shows the addons the engine ships itself, which are read-only ' +
    'here. The profile must be stopped for add and remove: the addon list is read when the browser ' +
    'starts, so a change now would only take effect after a restart.',
  flags: ADDON_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, ADDON_FLAGS)
    const output = createOutput(parsed.has('json'))

    const action = requirePositional(parsed, 0, 'action (list, add or remove)')
    if (action !== 'list' && action !== 'add' && action !== 'remove') {
      throw new CliError(`Unknown addons action "${action}" — use list, add or remove`)
    }
    const target = requirePositional(parsed, 1, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)

      if (action === 'list') {
        const addons = await core.addons.list(profile.id)
        output.result({ profileId: profile.id, name: profile.name, addons }, () => {
          output.table(addons, [
            { header: 'SLUG', value: addon => addon.slug },
            { header: 'NAME', value: addon => addon.name },
            { header: 'VERSION', value: addon => addon.version },
            { header: 'SOURCE', value: addon => addon.source },
            { header: 'FILES', value: addon => String(addon.files) },
          ])
          const engine = addons.filter(addon => addon.source === 'engine')
          if (engine.length > 0) {
            output.note(
              `note: ${engine.length} addon(s) come from the engine itself and cannot be removed.`,
            )
          }
          if (!addons.some(addon => addon.source === 'vfox')) {
            output.note(
              'note: this profile has no addons of its own — add one with ' +
                '`vfox addons add <profile> <path>`.',
            )
          }
        })
        return 0
      }

      if (action === 'add') {
        const source = requirePositional(parsed, 2, 'path to an extracted addon or an .xpi file')
        const file = path.resolve(source)
        if (!existsSync(file)) throw new CliError(`Addon source not found: ${file}`)

        const installed = await core.addons.install(profile.id, file, {
          replace: parsed.has('replace'),
        })
        output.result({ profileId: profile.id, name: profile.name, addon: installed }, () => {
          output.line(
            `Installed ${installed.name} ${installed.version} (${installed.slug}) into ` +
              `${profile.name} (${profile.id})`,
          )
          output.note('note: it loads the next time this profile is launched.')
        })
        return 0
      }

      const slug = requirePositional(parsed, 2, 'addon slug or gecko id')
      const removed = await core.addons.remove(profile.id, slug)
      output.result({ profileId: profile.id, name: profile.name, removed }, () => {
        output.line(
          `Removed ${removed.name} ${removed.version} (${removed.slug}) from ` +
            `${profile.name} (${profile.id})`,
        )
      })
      return 0
    } finally {
      await core.close()
    }
  },
}
