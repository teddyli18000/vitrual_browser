/**
 * Temp-file and download-header helpers.
 *
 * Zip export/import go through `core.profiles.exportZip` / `importZip`, which work on files, so the
 * HTTP layer stages them under `<dataDir>/tmp`. Keeping the staging area inside the data directory
 * (instead of the OS temp dir) means it is always writable next to the profile store and is cleaned
 * up with it.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { Core } from '@vfox/core'

export async function stagingPath(core: Core, prefix: string, extension: string): Promise<string> {
  const dir = path.join(core.dataDir, 'tmp')
  await mkdir(dir, { recursive: true })
  return path.join(dir, `${prefix}-${randomUUID()}${extension}`)
}

/** Best-effort delete; a leftover staging file must never turn into a failed request. */
export async function removeFile(file: string): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch {
    // Ignore: the file is already gone, or another process holds it.
  }
}

/** Keeps the filename inside ASCII so the `Content-Disposition` header stays valid. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'profile'
}

/** `filename` for legacy clients plus `filename*` (RFC 5987) for the real, possibly non-ASCII name. */
export function contentDisposition(filename: string): string {
  const ascii = sanitizeFilename(filename)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
