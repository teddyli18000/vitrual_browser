/**
 * Portable profile archive: `<id>.vfox.zip` containing
 *
 *   profile.json          { format, version, profile }  — the profile config, no id reuse
 *   userdata/<...>        the profile's browser data directory, forward-slash paths
 *
 * The layout is machine independent: importing assigns a fresh id, new timestamps, and clears
 * `groupId` (a group id from another machine would dangle). Anything that is not a VFox export is
 * rejected before a single byte is written, and a traversal attempt is rejected outright.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type Profile, ProfileSchema } from '@vfox/shared'
import AdmZip from 'adm-zip'

const PROFILE_ENTRY = 'profile.json'
const USERDATA_DIR = 'userdata'
const USERDATA_PREFIX = `${USERDATA_DIR}/`
const ARCHIVE_FORMAT = 'vfox-profile'
const ARCHIVE_VERSION = 1

interface ArchiveFile {
  /** Path relative to the profile's userdata directory, using forward slashes. */
  relative: string
  data: Buffer
}

/** Write `profile` + its userdata directory to `destFile`. */
export async function writeProfileZip(
  profile: Profile,
  userDataDir: string,
  destFile: string,
): Promise<void> {
  const zip = new AdmZip()
  const envelope = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, profile }
  zip.addFile(PROFILE_ENTRY, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8'))

  // The directory is walked here rather than with adm-zip's `addLocalFolderPromise`: that helper
  // runs the local path through `fixPath()` (a *zip-internal* path normaliser) before resolving it,
  // which on Windows turns `C:\…\userdata` into a path that does not exist. Its ENOENT branch then
  // resolves the promise without adding a single entry — a silently empty export. Walking it
  // ourselves also pins the in-archive layout to forward slashes on every platform.
  for (const relative of await listFiles(userDataDir)) {
    zip.addFile(
      `${USERDATA_PREFIX}${relative}`,
      await fs.readFile(path.join(userDataDir, relative)),
    )
  }

  const target = path.resolve(destFile)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.part`
  try {
    // Written next to the target and renamed, so a failed export never leaves a truncated zip
    // where the user expects a complete one.
    await zip.writeZipPromise(partial, { overwrite: true })
    await fs.rename(partial, target)
  } catch (error) {
    await fs.rm(partial, { force: true })
    throw error
  }
}

/** Every regular file under `root`, as forward-slash paths relative to it. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await fs
    .readdir(root, { recursive: true, withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return []
      }
      throw error
    })

  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const relative = path.relative(root, path.join(entry.parentPath, entry.name))
    files.push(relative.split(path.sep).join('/'))
  }
  return files
}

/**
 * Create a new profile from an archive produced by {@link writeProfileZip}.
 *
 * `insert` is the store's transactional insert; the userdata directory is only filled after every
 * entry has been validated, so a rejected archive never creates a partial profile.
 */
export async function importProfileZip(
  zipFile: string,
  name: string | undefined,
  insert: (profile: Profile, fill: (userDataDir: string) => Promise<void>) => Promise<Profile>,
): Promise<Profile> {
  const { archived, files } = await readProfileZip(zipFile)
  const now = new Date().toISOString()
  const imported = ProfileSchema.parse({
    ...archived,
    id: randomUUID(),
    name: name?.trim() || `${archived.name} (imported)`,
    // A group id from the exporting machine would dangle here.
    groupId: null,
    createdAt: now,
    updatedAt: now,
  })

  return insert(imported, async userDataDir => {
    if (files.length === 0) {
      // A profile that was never launched has no data directory; stay consistent with
      // `createProfile`, which also leaves it to the engine.
      return
    }
    await fs.mkdir(userDataDir, { recursive: true })
    for (const file of files) {
      const destination = path.join(userDataDir, file.relative)
      if (!isInside(userDataDir, destination)) {
        throw new Error(`Archive entry escapes the profile directory: ${file.relative}`)
      }
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, file.data)
    }
  })
}

async function readProfileZip(
  zipFile: string,
): Promise<{ archived: Profile; files: ArchiveFile[] }> {
  const source = path.resolve(zipFile)
  if (!(await exists(source))) {
    throw new Error(`Profile archive not found: ${source}`)
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(source)
  } catch (error) {
    throw new Error(`Not a readable zip archive: ${source} — ${message(error)}`, { cause: error })
  }

  const files: ArchiveFile[] = []
  let envelope: unknown

  for (const entry of zip.getEntries()) {
    const name = safeEntryName(entry.entryName)
    if (name === PROFILE_ENTRY) {
      try {
        envelope = JSON.parse(entry.getData().toString('utf8'))
      } catch (error) {
        throw new Error(`${PROFILE_ENTRY} in ${source} is not valid JSON — ${message(error)}`, {
          cause: error,
        })
      }
      continue
    }
    if (!name.startsWith(USERDATA_PREFIX)) {
      throw new Error(
        `Not a VFox profile export: unexpected entry "${entry.entryName}" (expected ` +
          `"${PROFILE_ENTRY}" or "${USERDATA_PREFIX}…")`,
      )
    }
    if (!entry.isDirectory) {
      files.push({ relative: name.slice(USERDATA_PREFIX.length), data: entry.getData() })
    }
  }

  if (envelope === undefined) {
    throw new Error(`Not a VFox profile export: ${source} has no ${PROFILE_ENTRY}`)
  }
  const header = envelope as { format?: unknown; version?: unknown; profile?: unknown }
  if (header.format !== ARCHIVE_FORMAT) {
    throw new Error(
      `Not a VFox profile export: expected format "${ARCHIVE_FORMAT}", got ${JSON.stringify(header.format)}`,
    )
  }
  if (header.version !== ARCHIVE_VERSION) {
    throw new Error(
      `Unsupported profile archive version ${JSON.stringify(header.version)} (this build reads ${ARCHIVE_VERSION})`,
    )
  }

  const parsed = ProfileSchema.safeParse(header.profile)
  if (!parsed.success) {
    throw new Error(`Profile config inside ${source} is invalid — ${parsed.error.message}`)
  }
  return { archived: parsed.data, files }
}

/**
 * Normalise an archive entry name and reject anything that could write outside the target
 * directory: absolute paths, drive letters, UNC paths, `..` segments and backslash tricks.
 */
function safeEntryName(entryName: string): string {
  const normalised = entryName.replace(/\\/g, '/')
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new Error(`Archive entry uses an absolute path: "${entryName}"`)
  }
  const segments = normalised.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) {
    throw new Error(`Archive entry escapes the extraction directory: "${entryName}"`)
  }
  if (segments.some(segment => /^[a-zA-Z]:$/.test(segment))) {
    // A drive-letter segment ("C:") anywhere turns the joined path into an absolute one.
    throw new Error(`Archive entry uses an absolute path: "${entryName}"`)
  }
  if (segments.length === 0) {
    throw new Error(`Archive entry has an empty name: "${entryName}"`)
  }
  return segments.join('/')
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
