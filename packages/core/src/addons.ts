/**
 * Per-profile addons: `<userdata>/vfox-addons/<slug>/`.
 *
 * ## Why this layout
 *
 * - **Inside `userdata`, not beside it.** `Store.cloneProfile` copies `userDataDir` and
 *   `archive.ts` zips `userDataDir`, so an addon installed here travels with clone and with profile
 *   export/import for free — an extension is part of the profile's disk. It is also the reason the
 *   profile zip is executable content, which the docs say out loud.
 * - **Not `<userdata>/extensions/`.** That is Firefox's own sideload directory. An addon there is
 *   loaded by the engine's `addons` option *and* by Firefox's XPIProvider — the same gecko id twice,
 *   from two paths. `vfox-addons/` is inert to Firefox; only the launcher knows about it.
 * - **An extracted directory is the unit.** `camoufox-js` requires each `addons` entry to be an
 *   existing directory containing `manifest.json` (`dist/addons.js` `confirmPaths`) and throws
 *   `InvalidAddonPath` otherwise — a single broken entry would make **every** launch of that profile
 *   fail. `listAddons()` therefore only ever returns directories whose manifest parses, and the
 *   launcher passes exactly what `listAddons()` returned.
 *
 * ## What is validated, and what is not
 *
 * An addon is arbitrary code with the browser's privileges; that is the user's choice, and VFox does
 * not judge it. What is checked is **structural**: the source exists and is either a directory with
 * a readable `manifest.json` or an archive whose every entry stays inside the destination, with
 * `MAX_ADDON_FILES`/`MAX_ADDON_BYTES` caps. There is deliberately **no signature check** — an
 * unsigned or self-signed addon that Firefox will happily run must not be rejected here.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProfileAddon } from '@vfox/shared'
import { MAX_ADDON_BYTES, MAX_ADDON_FILES, ProfileAddonSchema } from '@vfox/shared'
import AdmZip from 'adm-zip'

/** Directory inside the profile's userdata that holds VFox-managed addons. */
export const ADDON_STORE_DIR = 'vfox-addons'

/**
 * Slug prefix for addons the engine supplies itself (its bundled uBlock Origin). `:` cannot appear in
 * a sanitized user slug, so an engine entry can never collide with an installed one.
 */
export const ENGINE_ADDON_PREFIX = 'engine:'

export interface AddonInstallOptions {
  /** Replace an addon already installed under the same slug instead of refusing. */
  replace?: boolean
}

/** The profile's addon store. Nothing is created here; `listAddons` tolerates a missing directory. */
export function addonStoreDir(userDataDir: string): string {
  return path.join(userDataDir, ADDON_STORE_DIR)
}

/** Absolute path of one installed addon — what the engine is handed at launch. */
export function addonDir(userDataDir: string, slug: string): string {
  return path.join(addonStoreDir(userDataDir), slug)
}

/**
 * Every addon VFox manages for this profile, read from disk.
 *
 * A directory whose `manifest.json` is missing or unreadable is skipped rather than reported: it
 * could not be handed to the engine anyway, and reporting it as installed would be a lie.
 */
export async function listAddons(userDataDir: string): Promise<ProfileAddon[]> {
  const store = addonStoreDir(userDataDir)
  const entries = await fs.readdir(store, { withFileTypes: true }).catch(() => [])
  const addons: ProfileAddon[] = []
  for (const entry of entries) {
    // `.staging-*` and `.trash-*` are ours and half-written; a dot-prefixed name is never an addon.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const addon = await describeAddon(path.join(store, entry.name), entry.name, 'vfox').catch(
      () => null,
    )
    if (addon) addons.push(addon)
  }
  return addons.sort((left, right) => left.slug.localeCompare(right.slug))
}

/** The absolute paths the engine must load, in a **fresh** array (see the launcher's warning). */
export function addonPaths(userDataDir: string, addons: readonly ProfileAddon[]): string[] {
  return addons
    .filter(addon => addon.source === 'vfox')
    .map(addon => addonDir(userDataDir, addon.slug))
}

/**
 * Install an addon into a profile from a local path.
 *
 * The source may be an extracted addon directory (the engine's unit) or an `.xpi`/`.zip`, which is
 * extracted here — the engine cannot load an archive, so accepting one is a convenience for the user
 * who downloaded it, not a second storage format.
 *
 * The tree is built in `.staging-<uuid>` inside the store and only renamed into place once its
 * manifest parses, so a failed or refused install leaves the profile exactly as it was.
 */
export async function installAddon(
  userDataDir: string,
  sourcePath: string,
  options: AddonInstallOptions = {},
): Promise<ProfileAddon> {
  const source = path.resolve(sourcePath)
  const stats = await fs.stat(source).catch(() => null)
  if (!stats) {
    throw new Error(`Addon source not found: ${source}`)
  }

  const store = addonStoreDir(userDataDir)
  await fs.mkdir(store, { recursive: true })
  const staging = path.join(store, `.staging-${randomUUID()}`)

  try {
    if (stats.isDirectory()) {
      await copyTree(source, staging)
    } else if (stats.isFile()) {
      await extractArchive(source, staging)
    } else {
      throw new Error(
        `Addon source must be a directory containing manifest.json or an .xpi/.zip file: ${source}`,
      )
    }

    const manifest = await readManifest(staging)
    const slug = slugFor(manifest.id, source)
    const target = path.join(store, slug)
    const installed = await commit(staging, target, slug, options.replace ?? false)
    return installed
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Remove one addon from a profile.
 *
 * `target` is the record's slug or its gecko id — the id is what a user reads in `about:addons`, and
 * making them look up our directory name first would be pointless friction. The directory is renamed
 * out of the store before it is deleted, so a delete that fails halfway cannot leave a half-addon
 * that the launcher would then hand to the engine.
 */
export async function removeAddon(userDataDir: string, target: string): Promise<ProfileAddon> {
  if (target.startsWith(ENGINE_ADDON_PREFIX)) {
    const key = target.slice(ENGINE_ADDON_PREFIX.length)
    throw new Error(
      `"${key}" is provided by the engine itself and cannot be removed from a profile. ` +
        'Per-profile exclusion is not implemented yet.',
    )
  }

  const addons = await listAddons(userDataDir)
  const wanted = target.trim().toLowerCase()
  const match =
    addons.find(addon => addon.slug === target) ??
    addons.find(addon => addon.id !== null && addon.id === target) ??
    addons.find(addon => addon.slug.toLowerCase() === wanted) ??
    addons.find(addon => addon.id !== null && addon.id.toLowerCase() === wanted)

  if (!match) {
    const installed = addons.map(addon => addon.slug).join(', ')
    throw new Error(
      `No addon "${target}" in this profile` +
        (installed.length > 0 ? ` — installed: ${installed}` : ' (it has no addons)'),
    )
  }

  const dir = addonDir(userDataDir, match.slug)
  const trash = path.join(addonStoreDir(userDataDir), `.trash-${randomUUID()}`)
  await fs.rename(dir, trash)
  await fs.rm(trash, { recursive: true, force: true })
  return match
}

/**
 * Addons the engine supplies itself, read from `<engineDir>/addons/<KEY>`.
 *
 * `camoufox-js` downloads these (`DefaultAddons`, currently uBlock Origin) and appends their paths to
 * every launch (`dist/utils.js:384-390`), so they are loaded whether or not a profile asked for
 * them. They are reported so the browser's reality matches the API's answer, and they are read-only
 * because excluding one needs per-profile state that does not exist yet.
 */
export async function listEngineAddons(engineDir: string): Promise<ProfileAddon[]> {
  const defaults = await readEngineDefaults(engineDir)
  const addons: ProfileAddon[] = []
  for (const entry of defaults) {
    const slug = `${ENGINE_ADDON_PREFIX}${entry.key}`
    const addon = await describeAddon(entry.dir, slug, 'engine').catch(() => null)
    addons.push(addon ?? describeWithoutManifest(entry.key, entry.id))
  }
  return addons.sort((left, right) => left.slug.localeCompare(right.slug))
}

/**
 * Which engine defaults a profile would load **twice**, because it has its own copy of the same
 * addon. `exclude_addons` takes `DefaultAddons` keys, so this returns keys, not ids.
 *
 * Without this, a user who installs their own uBlock Origin gets the engine's copy as well: two
 * addons with one gecko id, from two different paths — a conflict Firefox resolves by picking one,
 * which is exactly the kind of silent surprise this feature exists to avoid.
 */
export async function excludeDefaultAddons(
  engineDir: string,
  ids: Iterable<string>,
): Promise<string[]> {
  const wanted = new Set(ids)
  if (wanted.size === 0) return []
  const keys: string[] = []
  for (const entry of await readEngineDefaults(engineDir)) {
    if (entry.id !== null && wanted.has(entry.id)) keys.push(entry.key)
  }
  return keys
}

/**
 * Delete engine addon directories that cannot be loaded, so camoufox-js downloads them again.
 *
 * camoufox-js trusts an existing directory and never looks inside it (`dist/addons.js:59-64`):
 *
 *     for (const addonName in addons) {
 *         const addonPath = getAddonPath(addonName);
 *         if (fs.existsSync(addonPath)) {
 *             addonsList.push(addonPath);
 *             continue;
 *         }
 *
 * …and then validates the very path it just trusted (`dist/addons.js:16-24`):
 *
 *     if (!fs.existsSync(path) || !fs.lstatSync(path).isDirectory()) throw new InvalidAddonPath(path);
 *     if (!fs.existsSync(join(path, 'manifest.json')))
 *         throw new InvalidAddonPath('manifest.json is missing. Addon path must be a path to an
 *         extracted addon.');
 *
 * So a directory left behind by a download that never finished is treated as a successful install on
 * the next attempt and then thrown out of `confirmPaths` — where we meet it as a 500 on a profile
 * launch. camoufox-js's own cleanup comment names that exact case: "Without this, the next retry sees
 * the directory and treats it as a successfully downloaded addon, then crashes with 'manifest.json is
 * missing' in confirmPaths."
 *
 * Removing it is the repair camoufox-js applies to itself after a failed download, applied here by the
 * side that keeps meeting the stale directory, before the path is handed over. A directory that does
 * hold a readable `manifest.json` is left exactly as it is; only entries that could never load go.
 */
export async function pruneEngineAddons(engineDir: string): Promise<string[]> {
  const root = path.join(engineDir, 'addons')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const removed: string[] = []
  for (const entry of entries) {
    const dir = path.join(root, entry.name)
    if (entry.isDirectory() && (await readManifest(dir).catch(() => null))) {
      continue
    }
    // A removal that fails (a locked directory, a read-only volume) is not fatal: the launch then
    // fails with camoufox-js's own message, which names the path — better than hiding the failure.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    removed.push(entry.name)
  }
  return removed
}

/* --------------------------------------------------------------------------------- internals */

interface AddonManifest {
  name: string
  version: string
  /** `browser_specific_settings.gecko.id` (MV3 and modern MV2) or `applications.gecko.id` (MV2). */
  id: string | null
}

interface EngineDefault {
  /** `DefaultAddons` key, e.g. `UBO` — what `exclude_addons` expects. */
  key: string
  dir: string
  id: string | null
}

async function readEngineDefaults(engineDir: string): Promise<EngineDefault[]> {
  const root = path.join(engineDir, 'addons')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const defaults: EngineDefault[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifest = await readManifest(dir).catch(() => null)
    defaults.push({ key: entry.name, dir, id: manifest?.id ?? null })
  }
  return defaults
}

async function describeAddon(
  dir: string,
  slug: string,
  source: 'vfox' | 'engine',
): Promise<ProfileAddon> {
  const manifest = await readManifest(dir)
  const stats = await fs.stat(dir)
  const measured = await measure(dir)
  return ProfileAddonSchema.parse({
    slug,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source,
    files: measured.files,
    bytes: measured.bytes,
    installedAt: stats.mtime.toISOString(),
  })
}

/** An engine default whose own directory is unreadable still exists and is still loaded. */
function describeWithoutManifest(key: string, id: string | null): ProfileAddon {
  return ProfileAddonSchema.parse({
    slug: `${ENGINE_ADDON_PREFIX}${key}`,
    id,
    name: key,
    version: 'unknown',
    source: 'engine',
    files: 0,
    bytes: 0,
    installedAt: new Date(0).toISOString(),
  })
}

/**
 * Read and validate `<dir>/manifest.json`.
 *
 * The two fields the record needs are `name` and `version`; a manifest without them is not something
 * Firefox would load either. The error message names the path, because "manifest.json is missing" on
 * its own does not tell the user which of their folders was wrong.
 */
async function readManifest(dir: string): Promise<AddonManifest> {
  const file = path.join(dir, 'manifest.json')
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (raw === null) {
    throw new Error(
      `No manifest.json in ${dir}. An addon is a directory containing manifest.json — if you ` +
        'pointed at an .xpi, pass the file itself and VFox will extract it.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${message(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} is not a JSON object`)
  }

  const record = parsed as Record<string, unknown>
  const name = record.name
  const version = record.version
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${file} has no "name" — this is not a WebExtension manifest`)
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${file} has no "version"`)
  }
  return { name, version, id: geckoId(record) }
}

/** Firefox reads the id from either key, depending on the manifest version. */
function geckoId(manifest: Record<string, unknown>): string | null {
  for (const key of ['browser_specific_settings', 'applications']) {
    const section = manifest[key]
    if (typeof section !== 'object' || section === null) continue
    const gecko = (section as Record<string, unknown>).gecko
    if (typeof gecko !== 'object' || gecko === null) continue
    const id = (gecko as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/**
 * The store directory name for an addon: its gecko id when it has one, so installing the same addon
 * twice replaces one directory instead of accumulating copies under different names.
 */
function slugFor(id: string | null, source: string): string {
  const base = id ?? path.basename(source).replace(/\.(xpi|zip)$/i, '')
  return sanitizeSlug(base)
}

/**
 * Filesystem-safe, and stable for the same input. `:` is replaced, which is what keeps an installed
 * slug from ever looking like an `engine:` entry.
 */
function sanitizeSlug(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._@-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '')
    .slice(0, 96)
  if (cleaned.length === 0) return 'addon'
  // A Windows device name is a directory that cannot exist; an addon whose id is `con` would fail
  // with EINVAL otherwise, which reads as a VFox bug rather than as a bad id.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned
}

/** Files and bytes under `root`, for the record and for the UI. */
async function measure(root: string): Promise<{ files: number; bytes: number }> {
  const entries = await fs
    .readdir(root, { recursive: true, withFileTypes: true })
    .catch(() => [] as never[])
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files += 1
    const stats = await fs.stat(path.join(entry.parentPath, entry.name)).catch(() => null)
    bytes += stats?.size ?? 0
  }
  return { files, bytes }
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    const source = path.join(entry.parentPath, entry.name)
    const relative = path.relative(from, source)
    if (!isInside(from, source)) {
      throw new Error(`Addon source contains a path outside itself: ${relative}`)
    }
    const destination = path.join(to, relative)
    if (entry.isDirectory()) {
      await fs.mkdir(destination, { recursive: true })
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }
    // Symlinks are neither followed nor copied: an addon that needs one is not a plain directory,
    // and following it could pull in anything the user can read.
  }
}

/**
 * Unpack an `.xpi`/`.zip` into `to`, refusing anything that would land outside it.
 *
 * The engine loads an extracted directory, so this is the only place an archive is understood. Every
 * entry is checked before it is written: an absolute path or a `..` segment would otherwise let an
 * archive write anywhere the user can write — the classic zip-slip, and the same discipline
 * `archive.ts` applies to an imported profile zip.
 */
async function extractArchive(file: string, to: string): Promise<void> {
  let zip: AdmZip
  try {
    zip = new AdmZip(file)
  } catch (error) {
    throw new Error(`${file} is not a readable zip archive: ${message(error)}`)
  }

  const entries = zip.getEntries()
  if (entries.length > MAX_ADDON_FILES) {
    throw new Error(
      `${file} holds ${entries.length} entries, more than the ${MAX_ADDON_FILES} limit`,
    )
  }

  let bytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    const destination = path.resolve(to, name)
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || !isInside(to, destination)) {
      throw new Error(`Archive entry escapes the addon directory: ${entry.entryName}`)
    }
    bytes += entry.header.size
    if (bytes > MAX_ADDON_BYTES) {
      throw new Error(`${file} is larger than the ${MAX_ADDON_BYTES} byte addon limit`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, entry.getData())
  }
}

/**
 * Move a staged tree into the store, replacing an existing addon only when asked.
 *
 * Windows cannot rename onto an existing directory, so a replacement is a three-step swap: the old
 * tree is renamed aside, the new one takes its place, and only then is the old one deleted. A failure
 * between the steps puts the old tree back rather than leaving the profile with no addon at all.
 */
async function commit(
  staging: string,
  target: string,
  slug: string,
  replace: boolean,
): Promise<ProfileAddon> {
  const store = path.dirname(target)
  const existing = await fs.stat(target).catch(() => null)
  if (existing && !replace) {
    throw new Error(
      `An addon is already installed as "${slug}" — remove it first, or install with replace.`,
    )
  }

  const trash = path.join(store, `.trash-${randomUUID()}`)
  if (existing) await fs.rename(target, trash)
  try {
    await fs.rename(staging, target)
  } catch (error) {
    if (existing) await fs.rename(trash, target).catch(() => {})
    throw error
  }
  if (existing) await fs.rm(trash, { recursive: true, force: true })

  return describeAddon(target, slug, 'vfox')
}

/** The same containment rule as `archive.ts`: a sibling prefix is not "inside". */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
