/**
 * Profile lookup shared by the HTTP routes and the MCP tools.
 *
 * The API accepts either a profile id or a profile name everywhere an id is expected. That is what
 * makes the VirtualBrowser-compatible aliases usable from existing automation scripts, which pass
 * human names, while the GUI keeps using ids.
 */

import type { Core } from '@vfox/core'
import type { Profile } from '@vfox/shared'

import { conflict, notFound } from './errors.js'

export async function findProfile(core: Core, idOrName: string): Promise<Profile> {
  const direct = await core.profiles.get(idOrName)
  if (direct) return direct

  const wanted = idOrName.trim().toLowerCase()
  const matches = (await core.profiles.list()).filter(
    (profile) => profile.name.toLowerCase() === wanted,
  )

  const first = matches[0]
  if (matches.length === 1 && first) return first
  if (matches.length > 1) {
    throw conflict(
      `Profile name "${idOrName}" is ambiguous (${matches.length} matches) — use the profile id`,
    )
  }
  throw notFound(`Unknown profile: ${idOrName}`)
}

export async function findProfileId(core: Core, idOrName: string): Promise<string> {
  return (await findProfile(core, idOrName)).id
}
