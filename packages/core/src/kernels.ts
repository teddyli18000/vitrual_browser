/**
 * Installed engine kernels: where they live, which one a profile launches with, and what happens when
 * the pinned one is gone.
 *
 * ## Layout
 *
 * ```
 * <kernelRoot>/                  CAMOUFOX_INSTALL_DIR, resolved at runtime and never persisted
 *   kernels/<version>/           a complete engine build (see below)
 *   version.json                 compatibility marker — see "the marker" below
 *   GeoLite2-City.mmdb           shared by every kernel
 *   addons/                      shared by every kernel
 *   camoufox.exe, …              a kernel installed by an older VFox, honoured in place
 * ```
 *
 * A kernel's directory is derived from its version, so a version string is the whole pin. Nothing
 * absolute is ever persisted: the root is resolved from the environment on every process start, which
 * is what keeps the product folder movable.
 *
 * **A kernel is a complete build, not an executable.** camoufox-js reads `properties.json` from the
 * directory the executable lives in and validates the launch config against it
 * (`camoufox-js/dist/utils.js:60-71`), so an `.exe` on its own is not a kernel and pinning one would
 * fail at launch. `inspectKernel()` enforces that here, once, for every caller.
 *
 * The legacy flat kernel is **never moved**. Renaming ~1 GB while a browser may hold those files open
 * is the one operation that can fail halfway, and "an installed kernel keeps working" is the point of
 * this feature; `location: 'legacy-root'` carries it honestly instead.
 *
 * ## The marker, and why it is not optional
 *
 * Every launch reaches `camoufoxPath()` through the addon path
 * (`utils.js:385` → `addons.js:47-60`), and that function starts camoufox-js's **own** engine
 * download when the root is missing or empty (`pkgman.js:300-321`). Measured on this machine: one
 * launch with a missing root produced 10 outbound requests — camoufox's release lookup plus a
 * separate uBlock Origin download. So while the root holds no engine of its own, `<root>/version.json`
 * mirrors the default kernel, and `ensureRootMarker()` is the only writer.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { InstalledKernel, KernelLocation, Profile } from '@vfox/shared'

/** Subdirectory holding versioned kernels. The directory name is the version. */
export const KERNELS_DIR_NAME = 'kernels'
const VERSION_FILE = 'version.json'
const PROPERTIES_FILE = 'properties.json'

/** The launcher inside a kernel build, per platform. Same mapping camoufox-js uses. */
const LAUNCHER_BY_PLATFORM: Record<string, string> = {
  win32: 'camoufox.exe',
  darwin: path.join('Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
  linux: 'camoufox',
}

export function kernelLauncherName(platform: string = process.platform): string {
  return LAUNCHER_BY_PLATFORM[platform] ?? LAUNCHER_BY_PLATFORM.win32 ?? 'camoufox.exe'
}

export function kernelLauncherPath(dir: string, platform: string = process.platform): string {
  return path.join(dir, kernelLauncherName(platform))
}

export interface KernelLayout {
  root: string
  kernelsDir: string
  markerFile: string
}

export function kernelLayout(root: string): KernelLayout {
  const resolved = path.resolve(root)
  return {
    root: resolved,
    kernelsDir: path.join(resolved, KERNELS_DIR_NAME),
    markerFile: path.join(resolved, VERSION_FILE),
  }
}

/** `{ version: '152.0.4', release: 'beta.30' }` → `152.0.4-beta.30`, the shape a pin stores. */
export function formatKernelVersion(version: string, release: string): string {
  return release ? `${version}-${release}` : version
}

/** Split a full version back into the `version.json` shape camoufox-js writes. */
export function splitKernelVersion(full: string): { version: string; release: string } {
  const at = full.indexOf('-')
  return at === -1
    ? { version: full, release: '' }
    : { version: full.slice(0, at), release: full.slice(at + 1) }
}

/** The version a kernel directory claims, or `null` when it has no readable `version.json`. */
export async function readKernelVersion(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, VERSION_FILE), 'utf8')) as {
      version?: unknown
      release?: unknown
    }
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      return null
    }
    return formatKernelVersion(raw.version, typeof raw.release === 'string' ? raw.release : '')
  } catch {
    return null
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Inspect one directory as a candidate kernel. Returns `null` when there is nothing there at all,
 * and an entry with `problem` set when there is something that cannot be launched.
 *
 * `withSize` is off for the launch path: measuring a ~1 GB tree costs a directory walk, and a launch
 * only needs to know *which* kernel, not how big it is. `kernel.info()` is the caller that wants the
 * number.
 */
export async function inspectKernel(
  dir: string,
  location: KernelLocation,
  withSize = true,
): Promise<InstalledKernel | null> {
  if (!(await exists(dir))) {
    return null
  }
  const version = await readKernelVersion(dir)
  if (!version) {
    // A directory with no version.json is not a kernel: it is either an interrupted install or the
    // marker-only root. Either way it must not be launchable, and it must not be silently adopted.
    return null
  }
  const problems: string[] = []
  const launcher = await exists(kernelLauncherPath(dir))
  if (!launcher) {
    if (location === 'legacy-root') {
      // THE distinction this scanner exists to make, learned the hard way: a *legacy root* with no
      // launcher is the shared data directory (addons, the GeoIP database, and the `version.json`
      // marker `ensureRootMarker()` maintains) — not a kernel. Reporting it listed a phantom "legacy"
      // build next to the real ones and made a refusal message print the same version twice.
      //
      // A *versioned* directory with no launcher is the opposite case and is still reported below:
      // that one is a half-finished install, and the user needs to see it rather than have the
      // directory silently ignored.
      return null
    }
    problems.push(`no ${kernelLauncherName()} in the build`)
  }
  if (!(await exists(path.join(dir, PROPERTIES_FILE)))) {
    problems.push(`no ${PROPERTIES_FILE} (the engine's config schema lives there)`)
  }
  if (location === 'kernels' && path.basename(dir) !== version) {
    problems.push(`directory name disagrees with version.json (${version})`)
  }
  return {
    version,
    path: dir,
    location,
    // A legacy kernel lives in the same directory as `kernels/`, so its size must not count the
    // other kernels twice.
    bytes: withSize
      ? await directoryBytes(dir, location === 'legacy-root' ? [KERNELS_DIR_NAME] : [])
      : 0,
    profileCount: 0,
    isDefault: false,
    problem: problems.length > 0 ? problems.join('; ') : null,
  }
}

/**
 * Every kernel directory under the root: `kernels/<version>/` plus a legacy flat build at the root.
 *
 * Order is newest first, so a caller that ignores the rules still gets the most recent build.
 */
export async function listInstalledKernels(
  root: string,
  options: { withSize?: boolean } = {},
): Promise<InstalledKernel[]> {
  const withSize = options.withSize ?? true
  const layout = kernelLayout(root)
  const found: InstalledKernel[] = []

  let entries: string[] = []
  try {
    entries = await fs.readdir(layout.kernelsDir)
  } catch {
    entries = []
  }
  for (const entry of entries.sort()) {
    const kernel = await inspectKernel(path.join(layout.kernelsDir, entry), 'kernels', withSize)
    if (kernel) {
      found.push(kernel)
    }
  }

  const legacy = await inspectKernel(layout.root, 'legacy-root', withSize)
  if (legacy) {
    found.push(legacy)
  }

  return found.sort((a, b) => compareKernelVersions(b.version, a.version))
}

/** Kernels that can actually be launched. */
export function usableKernels(kernels: readonly InstalledKernel[]): InstalledKernel[] {
  return kernels.filter(kernel => kernel.problem === null)
}

/**
 * The kernel an unpinned profile and a newly created profile get.
 *
 * The build's preferred version wins when it is installed, then a legacy root build (that is what the
 * previous version of the product installed and what its users are running), then the newest usable
 * one. Deterministic, and it needs no persisted "current version" file.
 */
export function defaultKernelVersion(
  kernels: readonly InstalledKernel[],
  preferred: string | null,
): string | null {
  const usable = usableKernels(kernels)
  if (preferred && usable.some(kernel => kernel.version === preferred)) {
    return preferred
  }
  const legacy = usable.find(kernel => kernel.location === 'legacy-root')
  if (legacy) {
    return legacy.version
  }
  return usable[0]?.version ?? null
}

/**
 * Keep `<root>/version.json` describing something real, so camoufox-js cannot start its own download.
 *
 * When the root holds a kernel of its own, that file is the build's own and is left alone. Otherwise
 * it mirrors the default kernel: `camoufoxPath()` only needs a supported version to return the root,
 * and the root is where the shared `addons/` and GeoLite database live.
 */
export async function ensureRootMarker(root: string, defaultVersion: string | null): Promise<void> {
  const layout = kernelLayout(root)
  if (await exists(kernelLauncherPath(layout.root))) {
    return
  }
  if (!defaultVersion) {
    return
  }
  await fs.mkdir(layout.root, { recursive: true })
  await fs.writeFile(layout.markerFile, JSON.stringify(splitKernelVersion(defaultVersion)), 'utf8')
}

export type KernelResolutionSource = 'pinned' | 'born-with' | 'default'

export type KernelResolution =
  | {
      ok: true
      version: string
      dir: string
      source: KernelResolutionSource
      /** Set when the profile launches on a different engine than its identity was born with. */
      warning: string | null
    }
  | { ok: false; code: 'kernel_missing'; message: string }

export interface ResolveKernelOptions {
  profile: Pick<Profile, 'id' | 'name' | 'kernel' | 'identity'>
  kernels: readonly InstalledKernel[]
  /** The build's preferred version, normally `ENGINE_VERSION`. */
  preferred: string | null
}

/**
 * The resolution matrix, in one place:
 *
 * | profile                          | resolves to                                  | missing pin |
 * | -------------------------------- | -------------------------------------------- | ----------- |
 * | `kernel: "X"` (explicit pin)     | X                                            | refuse      |
 * | `kernel: null`, identity engine X| X if installed, else the default (+ warning) | launch      |
 * | `kernel: null`, no identity      | the default                                  | refuse if none |
 *
 * An explicit pin is a contract, so it is never silently downgraded: launching on another engine
 * changes the fingerprint the profile reports, at the moment the user believes they are reusing a
 * working fleet, and leaves no trace afterwards. An unpinned profile has no such contract — it is a
 * store written before kernels could be pinned — so it launches and says what it did.
 */
export function resolveKernelForProfile(options: ResolveKernelOptions): KernelResolution {
  const usable = usableKernels(options.kernels)
  const byVersion = new Map(usable.map(kernel => [kernel.version, kernel]))
  const label = `"${options.profile.name}"`

  if (options.profile.kernel) {
    const pinned = byVersion.get(options.profile.kernel)
    if (!pinned) {
      return {
        ok: false,
        code: 'kernel_missing',
        message: pinnedMissingMessage({
          label,
          id: options.profile.id,
          pinned: options.profile.kernel,
          kernels: options.kernels,
          defaultVersion: defaultKernelVersion(options.kernels, options.preferred),
        }),
      }
    }
    return { ok: true, version: pinned.version, dir: pinned.path, source: 'pinned', warning: null }
  }

  const bornWith = options.profile.identity?.engine ?? null
  if (bornWith && byVersion.has(bornWith)) {
    const kernel = byVersion.get(bornWith)
    if (kernel) {
      return {
        ok: true,
        version: kernel.version,
        dir: kernel.path,
        source: 'born-with',
        warning: null,
      }
    }
  }

  const fallback = defaultKernelVersion(options.kernels, options.preferred)
  const kernel = fallback ? byVersion.get(fallback) : undefined
  if (!kernel) {
    return {
      ok: false,
      code: 'kernel_missing',
      message:
        `Cannot launch ${label}: no engine is installed.\n` +
        'Install one from Settings → Engine, or run `vfox kernel install`.',
    }
  }

  const warning = bornWith
    ? `profile ${options.profile.id} was created on engine ${bornWith}, which is not installed; ` +
      `launching on ${kernel.version} instead — the fingerprint this profile reports may differ`
    : null
  return { ok: true, version: kernel.version, dir: kernel.path, source: 'default', warning }
}

function pinnedMissingMessage(input: {
  label: string
  id: string
  pinned: string
  kernels: readonly InstalledKernel[]
  defaultVersion: string | null
}): string {
  const usable = usableKernels(input.kernels)
  const installed = usable.length
    ? usable
        .map(
          kernel =>
            `${kernel.version}${kernel.version === input.defaultVersion ? ' (default)' : ''}`,
        )
        .join(', ')
    : 'none'
  const fix = input.defaultVersion
    ? `install ${input.pinned} (Settings → Engine), or re-pin this profile ` +
      `(\`vfox kernel pin ${input.id} ${input.defaultVersion}\`)`
    : `install ${input.pinned} from Settings → Engine, or run \`vfox kernel install --version ${input.pinned}\``
  return (
    `Cannot launch ${input.label}: it is pinned to engine ${input.pinned}, which is not installed.\n` +
    `Installed: ${installed}.\n` +
    `Fix: ${fix}. Launching on a different engine would change the fingerprint this profile ` +
    'reports, so VFox refuses instead.'
  )
}

/**
 * Recursive size of a kernel directory, for the disk cost the settings panel shows.
 *
 * `exclude` exists for exactly one caller and one measured bug: a legacy kernel lives in the engine
 * root, and `kernels/` is a subdirectory of that same root, so counting the root naively reported a
 * 3 MB legacy build plus two 3 MB kernels as 12 MB. The exclusion names top-level directory entries
 * of `dir`, not paths.
 */
export async function directoryBytes(
  dir: string,
  exclude: readonly string[] = [],
): Promise<number> {
  const skipped = new Set(exclude)
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      break
    }
    let entries: string[]
    try {
      entries = await fs.readdir(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (current === dir && skipped.has(entry)) {
        continue
      }
      const target = path.join(current, entry)
      try {
        const stats = await fs.stat(target)
        if (stats.isDirectory()) {
          stack.push(target)
        } else if (stats.isFile()) {
          total += stats.size
        }
      } catch {
        // A file that vanished mid-walk is not worth failing a size report over.
      }
    }
  }
  return total
}

/** Numeric-aware version order, so `beta.9` sorts below `beta.10` rather than after it. */
export function compareKernelVersions(a: string, b: string): number {
  const [aVersion = '', aRelease = ''] = a.split('-')
  const [bVersion = '', bRelease = ''] = b.split('-')
  const numeric = (value: string): number[] =>
    value.split('.').map(part => (Number.isFinite(Number(part)) ? Number(part) : -1))
  for (const [left, right] of [
    [numeric(aVersion), numeric(bVersion)],
    [numeric(aRelease), numeric(bRelease)],
  ] as const) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (left[index] ?? 0) - (right[index] ?? 0)
      if (diff !== 0) {
        return diff
      }
    }
  }
  return 0
}
