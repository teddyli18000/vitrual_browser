/**
 * "Disk usage" of a profile — the browser data directory is the VM's virtual disk, and knowing
 * how big it grew is genuinely useful before cloning or exporting it.
 *
 * The walk is bounded and cached: a profile directory can hold tens of thousands of files and
 * the UI must never block on it.
 */

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProfileUsage {
  path: string
  exists: boolean
  bytes: number
  files: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; value: ProfileUsage }>()

async function walk(dir: string, budget: { files: number; bytes: number }): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, budget)
    } else if (entry.isFile()) {
      try {
        const info = await stat(full)
        budget.files += 1
        budget.bytes += info.size
      } catch {
        // A file that vanished mid-walk simply does not count.
      }
    }
  }
}

export async function profileUsage(dir: string): Promise<ProfileUsage> {
  const cached = cache.get(dir)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const budget = { files: 0, bytes: 0 }
  let exists = false
  try {
    exists = (await stat(dir)).isDirectory()
  } catch {
    exists = false
  }
  if (exists) await walk(dir, budget)

  const value: ProfileUsage = { path: dir, exists, bytes: budget.bytes, files: budget.files }
  cache.set(dir, { at: Date.now(), value })
  return value
}
