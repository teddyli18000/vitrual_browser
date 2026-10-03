/**
 * API token handling.
 *
 * Resolution order: explicit option -> `VFOX_API_TOKEN` -> `<dataDir>/api-token` -> freshly
 * generated and persisted with owner-only permissions. The token is never logged, never
 * written into the repo and never sent anywhere: it only guards the loopback HTTP socket.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ENV } from '@vfox/shared'

import { apiTokenPath } from './paths.js'

export interface ResolveTokenOptions {
  dataDir: string
  token?: string
}

export interface ResolvedToken {
  token: string
  /** `true` when the token was read from or written to `<dataDir>/api-token`. */
  persisted: boolean
}

export async function resolveToken(options: ResolveTokenOptions): Promise<ResolvedToken> {
  const explicit = options.token ?? process.env[ENV.apiToken]
  if (explicit && explicit.length > 0) return { token: explicit, persisted: false }

  const file = apiTokenPath(options.dataDir)
  const existing = await readTokenFile(file)
  if (existing) return { token: existing, persisted: true }

  const token = randomBytes(32).toString('hex')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return { token, persisted: true }
}

async function readTokenFile(file: string): Promise<string | undefined> {
  try {
    const raw = await readFile(file, 'utf8')
    const token = raw.trim()
    return token.length > 0 ? token : undefined
  } catch {
    // Missing file (or unreadable) simply means "no persisted token yet".
    return undefined
  }
}

/** Constant-time comparison; never short-circuits on the first differing byte. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
