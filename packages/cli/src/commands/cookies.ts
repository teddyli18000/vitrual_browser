import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { parseArgs, requirePositional, UsageError } from '../args.js'
import type { Command } from '../command.js'
import { GLOBAL_FLAGS } from '../command.js'
import { CliError, openCore, resolveProfile } from '../core.js'
import { createOutput } from '../output.js'

const COOKIE_FLAGS = [
  ...GLOBAL_FLAGS,
  { name: 'out', kind: 'string', description: 'File to write (export)' },
  { name: 'in', kind: 'string', description: 'File to read (import)' },
  {
    name: 'replace',
    kind: 'boolean',
    description: 'Import: delete every cookie in the profile before writing the file',
  },
] as const

/**
 * The account-moving workflow: register in one profile, move the session to another.
 *
 * The file is Netscape `cookies.txt` — the format curl, wget and yt-dlp read and write — so a
 * session that leaves VFox stays usable elsewhere. Both directions go through `core.cookies`, which
 * reads and writes the profile's own `cookies.sqlite`, and both require the profile to be stopped.
 */
export const cookiesCommand: Command = {
  name: 'cookies',
  summary: 'Move a logged-in session in or out of a profile',
  usage: 'vfox cookies export|import <id|name> --out|--in <file> [--replace]',
  details:
    'export writes a Netscape cookies.txt file; import merges one in. Both need the profile to be ' +
    'stopped, because the cookie store on disk is what is read and written and a running browser ' +
    'owns it — nothing is launched. `import` merges by default (upserting on host + name + path and ' +
    'leaving every other cookie alone); `--replace` empties the jar first so the profile ends up ' +
    'with exactly the file. SameSite is not part of the format, so imported cookies land as ' +
    '"unspecified" (Firefox treats that as Lax).',
  flags: COOKIE_FLAGS,
  run: async ({ argv, dataDir }) => {
    const parsed = parseArgs(argv, COOKIE_FLAGS)
    const output = createOutput(parsed.has('json'))

    const action = requirePositional(parsed, 0, 'action (export or import)')
    if (action !== 'export' && action !== 'import') {
      throw new CliError(`Unknown cookies action "${action}" — use export or import`)
    }
    const target = requirePositional(parsed, 1, 'profile id or name')

    const core = await openCore(dataDir)
    try {
      const profile = await resolveProfile(core, target)

      if (action === 'export') {
        const out = parsed.get('out')
        if (out === undefined) throw new UsageError('--out <file> is required for cookies export')
        const file = path.resolve(out)

        const exported = await core.cookies.export(profile.id)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, exported.content, 'utf8')

        output.result(
          {
            profileId: profile.id,
            name: profile.name,
            file,
            cookies: exported.cookies,
            hasCookieStore: exported.hasCookieStore,
            skipped: exported.skipped,
          },
          () => {
            output.line(
              `Exported ${exported.cookies} cookie(s) from ${profile.name} (${profile.id}) -> ${file}`,
            )
            if (!exported.hasCookieStore) {
              output.note(
                'note: this profile has no cookie store yet — launch it once so the engine creates one.',
              )
            }
            for (const skip of exported.skipped) {
              output.note(`skipped ${skip.detail}: ${skip.reason}`)
            }
          },
        )
        return 0
      }

      const input = parsed.get('in')
      if (input === undefined) throw new UsageError('--in <file> is required for cookies import')
      const file = path.resolve(input)
      if (!existsSync(file)) throw new CliError(`File not found: ${file}`)

      const mode = parsed.has('replace') ? 'replace' : 'merge'
      const content = await readFile(file, 'utf8')
      const result = await core.cookies.import(profile.id, content, { mode })

      output.result({ ...result, name: profile.name, file }, () => {
        output.line(
          `Imported ${result.written} cookie(s) into ${profile.name} (${profile.id}) from ${file}`,
        )
        if (result.updated > 0) output.line(`  ${result.updated} existing cookie(s) updated`)
        if (result.removed > 0) {
          output.note(`  ${result.removed} existing cookie(s) deleted first (--replace)`)
        }
        for (const skip of result.skipped) {
          output.note(`skipped line ${skip.line ?? '?'}: ${skip.reason}`)
        }
      })
      return 0
    } finally {
      await core.close()
    }
  },
}
