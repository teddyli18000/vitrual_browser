/**
 * Core access for the CLI.
 *
 * Every command is a thin wrapper over `@vfox/core`; the CLI never reimplements storage, zipping
 * or launching. `@vfox/core` and `@vfox/server` are imported lazily so `vfox --help` and the
 * argument parser stay instant and do not drag Fastify or the engine into the process.
 */

import type { Core } from '@vfox/core'
import type { Group, Profile, ProxyConfig } from '@vfox/shared'
import { ProxySchema } from '@vfox/shared'

import { UsageError } from './args.js'
import { createStderrLogger } from './output.js'

/** A runtime failure the user can act on; printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/** Same rule as the server and the desktop app: explicit -> `VFOX_DATA_DIR` -> `%APPDATA%/vfox`. */
export async function resolveDataDir(explicit?: string): Promise<string> {
  const { resolveDataDir: resolve } = await import('@vfox/server')
  return resolve(explicit)
}

export async function openCore(dataDir?: string): Promise<Core> {
  const { createCore } = await import('@vfox/core')
  return createCore({
    dataDir: await resolveDataDir(dataDir),
    // stderr only: `vfox mcp` speaks its protocol over stdout.
    logger: createStderrLogger(),
  })
}

/** Accepts a profile id or an exact (case-insensitive) profile name. */
export async function resolveProfile(core: Core, idOrName: string): Promise<Profile> {
  const direct = await core.profiles.get(idOrName)
  if (direct) return direct

  const wanted = idOrName.trim().toLowerCase()
  const matches = (await core.profiles.list()).filter(
    (profile) => profile.name.toLowerCase() === wanted,
  )
  const first = matches[0]
  if (matches.length === 1 && first) return first
  if (matches.length > 1) {
    throw new CliError(`Profile name "${idOrName}" is ambiguous (${matches.length} matches) — use the id`)
  }
  throw new CliError(`Unknown profile: ${idOrName}`)
}

/**
 * Accepts a group id or name. `--group` creates the group on demand, which keeps the documented
 * command set self-sufficient (there is no separate `vfox group` command).
 */
export async function resolveGroup(
  core: Core,
  idOrName: string,
  options: { create: boolean },
): Promise<Group> {
  const groups = await core.groups.list()
  const wanted = idOrName.trim().toLowerCase()
  const found =
    groups.find((group) => group.id === idOrName) ??
    groups.find((group) => group.name.toLowerCase() === wanted)
  if (found) return found
  if (!options.create) throw new CliError(`Unknown group: ${idOrName}`)
  return core.groups.create(idOrName.trim())
}

const DEFAULT_PROXY_PORTS: Record<string, number> = { http: 8080, https: 443, socks5: 1080 }

/** `socks5://user:pass@host:1080` -> the shared `ProxyConfig` shape, validated by the schema. */
export function parseProxyUrl(raw: string): ProxyConfig {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UsageError(`--proxy must be a URL, e.g. socks5://user:pass@127.0.0.1:1080 (got "${raw}")`)
  }

  const type = parsed.protocol.replace(/:$/, '').toLowerCase()
  const fallbackPort = DEFAULT_PROXY_PORTS[type]
  if (!fallbackPort) {
    throw new UsageError(
      `Unsupported proxy scheme "${type}" — use http://, https:// or socks5:// (got "${raw}")`,
    )
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : fallbackPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`Invalid proxy port in "${raw}"`)
  }

  const candidate = {
    type,
    host: parsed.hostname,
    port,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  }
  const result = ProxySchema.safeParse(candidate)
  if (!result.success) {
    throw new UsageError(`Invalid proxy URL "${raw}": ${result.error.issues[0]?.message ?? 'unknown error'}`)
  }
  return result.data
}

/** Waits for a runtime transition without polling: it resolves on the core's `change` event. */
export function waitForRunning(
  core: Core,
  profileId: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
    }
    const timer = setTimeout(() => {
      finish()
      reject(new CliError(`Timed out after ${timeoutMs} ms waiting for the profile to start`))
    }, timeoutMs)
    timer.unref?.()

    const unsubscribe = core.runtime.on('change', (runtime) => {
      if (runtime.profileId !== profileId) return
      if (runtime.status === 'running') {
        finish()
        resolve()
        return
      }
      if (runtime.status === 'error') {
        finish()
        reject(new CliError(runtime.lastError ?? 'The profile failed to start'))
      }
    })
  })
}
