/**
 * Engine kernels: the layout, the resolution matrix, and the migration of a store written before
 * kernels could be pinned.
 *
 * These run against real directories and a real `profiles.json` fixture, because the two things that
 * can go wrong here are both about what is on disk: a kernel that is not where the resolver looks, and
 * an old store that the new schema rejects.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type Profile, ProfileSchema } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKernelVersion,
  directoryBytes,
  ensureRootMarker,
  formatKernelVersion,
  kernelLauncherName,
  kernelLauncherPath,
  kernelLayout,
  listInstalledKernels,
  readKernelVersion,
  resolveKernelForProfile,
  usableKernels,
} from '../src/kernels.js'
import type { BrowserExit, BrowserHandle, BrowserLauncher } from '../src/launcher.js'
import { RuntimeRegistry } from '../src/runtime.js'
import { Store } from '../src/store.js'

const PREFERRED = '152.0.4-beta.30'
const OTHER = '152.0.4-beta.28'

let root: string
let dataDir: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-kernels-'))
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-store-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** A complete kernel build: the launcher, version.json, and the engine's property table. */
async function writeKernel(dir: string, version: string, options: { launcher?: boolean } = {}) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'version.json'),
    JSON.stringify(
      version.includes('-')
        ? {
            version: version.slice(0, version.indexOf('-')),
            release: version.slice(version.indexOf('-') + 1),
          }
        : { version, release: '' },
    ),
  )
  await fs.writeFile(
    path.join(dir, 'properties.json'),
    JSON.stringify([{ property: 'canvas:seed', type: 'int' }]),
  )
  if (options.launcher !== false) {
    await fs.writeFile(kernelLauncherPath(dir), 'stub')
  }
  return dir
}

async function versionedKernel(version: string, options: { launcher?: boolean } = {}) {
  return writeKernel(path.join(kernelLayout(root).kernelsDir, version), version, options)
}

async function legacyKernel(version: string) {
  return writeKernel(root, version)
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return ProfileSchema.parse({
    id: 'p1',
    name: 'Shop 04',
    fingerprint: {},
    launch: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  })
}

describe('kernel layout', () => {
  it('names the launcher per platform, which is what a fixture must use too', () => {
    // Asserted directly because hard-coding `camoufox.exe` in a fixture made every kernel invisible on
    // the Linux CI runner: an install that had worked was reported as having no launcher. A fixture
    // that names a launcher goes through the same helper the product uses.
    expect(kernelLauncherName('win32')).toBe('camoufox.exe')
    expect(kernelLauncherName('linux')).toBe('camoufox')
    expect(kernelLauncherName('darwin')).toContain('camoufox')
    expect(kernelLauncherPath('/engines/k', 'linux')).toBe(path.join('/engines/k', 'camoufox'))
  })

  it('derives a kernel directory from its version, and reads the version back', async () => {
    const dir = await versionedKernel(PREFERRED)
    const layout = kernelLayout(root)

    expect(dir).toBe(path.join(layout.root, 'kernels', PREFERRED))
    expect(await readKernelVersion(dir)).toBe(PREFERRED)
    expect(formatKernelVersion('152.0.4', 'beta.30')).toBe(PREFERRED)
  })

  it('lists versioned kernels and a legacy flat build, newest first', async () => {
    await versionedKernel(PREFERRED)
    await versionedKernel(OTHER)
    await legacyKernel('152.0.4-beta.26')

    const kernels = await listInstalledKernels(root)

    expect(kernels.map(kernel => [kernel.version, kernel.location])).toEqual([
      [PREFERRED, 'kernels'],
      [OTHER, 'kernels'],
      ['152.0.4-beta.26', 'legacy-root'],
    ])
    expect(usableKernels(kernels)).toHaveLength(3)
  })

  it('reports a directory whose name disagrees with its version.json instead of guessing', async () => {
    const dir = path.join(kernelLayout(root).kernelsDir, 'not-a-version')
    await writeKernel(dir, PREFERRED)

    const kernels = await listInstalledKernels(root)

    expect(kernels).toHaveLength(1)
    expect(kernels[0]?.problem).toContain('directory name disagrees')
    expect(usableKernels(kernels)).toHaveLength(0)
  })

  it('rejects a build that is only an executable, because the engine config schema lives beside it', async () => {
    const dir = await versionedKernel(PREFERRED)
    await fs.rm(path.join(dir, 'properties.json'))

    const kernels = await listInstalledKernels(root)

    expect(kernels[0]?.problem).toContain('properties.json')
    expect(usableKernels(kernels)).toHaveLength(0)
  })

  it('measures the disk cost of a kernel directory', async () => {
    const dir = await versionedKernel(PREFERRED)
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(dir, 'nested', 'payload.bin'), Buffer.alloc(2048))

    const bytes = await directoryBytes(dir)

    expect(bytes).toBeGreaterThanOrEqual(2048)
    expect(bytes).toBeLessThan(10_000)
  })
})

describe('the default kernel', () => {
  it('prefers the build’s version, then a legacy root build, then the newest', async () => {
    await versionedKernel(OTHER)
    await legacyKernel('152.0.4-beta.26')
    expect(defaultKernelVersion(await listInstalledKernels(root), PREFERRED)).toBe(
      '152.0.4-beta.26',
    )

    await versionedKernel(PREFERRED)
    expect(defaultKernelVersion(await listInstalledKernels(root), PREFERRED)).toBe(PREFERRED)
  })

  it('orders prereleases numerically, so beta.9 sorts below beta.10', async () => {
    await versionedKernel('152.0.4-beta.9')
    await versionedKernel('152.0.4-beta.10')

    const kernels = await listInstalledKernels(root)

    expect(kernels.map(kernel => kernel.version)).toEqual(['152.0.4-beta.10', '152.0.4-beta.9'])
  })
})

describe('the root marker', () => {
  it('mirrors the default kernel when the root holds no engine of its own', async () => {
    await versionedKernel(PREFERRED)

    await ensureRootMarker(root, PREFERRED)

    expect(await readKernelVersion(root)).toBe(PREFERRED)
  })

  it('leaves a legacy root build’s own version.json alone', async () => {
    await legacyKernel('152.0.4-beta.26')

    await ensureRootMarker(root, PREFERRED)

    expect(await readKernelVersion(root)).toBe('152.0.4-beta.26')
  })

  it('writes nothing when no kernel is installed', async () => {
    await ensureRootMarker(root, null)

    expect(await readKernelVersion(root)).toBeNull()
  })
})

describe('the resolution matrix', () => {
  it('uses the pinned version when it is installed', async () => {
    await versionedKernel(PREFERRED)
    await versionedKernel(OTHER)
    const kernels = await listInstalledKernels(root, { withSize: false })

    const resolution = resolveKernelForProfile({
      profile: profile({ kernel: OTHER }),
      kernels,
      preferred: PREFERRED,
    })

    expect(resolution).toMatchObject({ ok: true, version: OTHER, source: 'pinned', warning: null })
  })

  it('refuses to launch when the pinned version is missing, and says what to do', async () => {
    await versionedKernel(PREFERRED)
    const kernels = await listInstalledKernels(root, { withSize: false })

    const resolution = resolveKernelForProfile({
      profile: profile({ kernel: OTHER }),
      kernels,
      preferred: PREFERRED,
    })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.code).toBe('kernel_missing')
    expect(resolution.message).toContain('Cannot launch "Shop 04"')
    expect(resolution.message).toContain(`pinned to engine ${OTHER}, which is not installed`)
    expect(resolution.message).toContain(`${PREFERRED} (default)`)
    expect(resolution.message).toContain('re-pin this profile')
    expect(resolution.message).toContain('vfox kernel pin p1 152.0.4-beta.30')
  })

  it('follows the engine the identity was born with when the profile is unpinned', async () => {
    await versionedKernel(PREFERRED)
    await versionedKernel(OTHER)
    const kernels = await listInstalledKernels(root, { withSize: false })

    const resolution = resolveKernelForProfile({
      profile: profile({
        identity: { version: 1, engine: OTHER, generatedAt: '', fingerprint: {} },
      }),
      kernels,
      preferred: PREFERRED,
    })

    expect(resolution).toMatchObject({ ok: true, version: OTHER, source: 'born-with' })
  })

  it('launches an unpinned profile on the default and warns when its engine is gone', async () => {
    await versionedKernel(PREFERRED)
    const kernels = await listInstalledKernels(root, { withSize: false })

    const resolution = resolveKernelForProfile({
      profile: profile({
        identity: { version: 1, engine: OTHER, generatedAt: '', fingerprint: {} },
      }),
      kernels,
      preferred: PREFERRED,
    })

    expect(resolution).toMatchObject({ ok: true, version: PREFERRED, source: 'default' })
    if (!resolution.ok) throw new Error('expected a resolution')
    expect(resolution.warning).toContain(`created on engine ${OTHER}`)
    expect(resolution.warning).toContain('may differ')
  })

  it('resolves a store with no pin and no identity — the oldest shape — to the default', async () => {
    await versionedKernel(PREFERRED)
    const kernels = await listInstalledKernels(root, { withSize: false })

    const resolution = resolveKernelForProfile({
      profile: profile(),
      kernels,
      preferred: PREFERRED,
    })

    expect(resolution).toMatchObject({
      ok: true,
      version: PREFERRED,
      source: 'default',
      warning: null,
    })
  })

  it('refuses when nothing is installed at all, and names the action', async () => {
    // An unpinned profile — the store shape from before pinning existed — with no kernel installed.
    const resolution = resolveKernelForProfile({
      profile: profile(),
      kernels: [],
      preferred: PREFERRED,
    })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.message).toContain('no engine is installed')
    expect(resolution.message).toContain('vfox kernel install')
  })

  it('refuses a pinned profile with no kernels at all by naming the pin', async () => {
    const resolution = resolveKernelForProfile({
      profile: profile({ kernel: PREFERRED }),
      kernels: [],
      preferred: PREFERRED,
    })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.message).toContain(`pinned to engine ${PREFERRED}`)
    expect(resolution.message).toContain('Installed: none')
    expect(resolution.message).toContain('--version 152.0.4-beta.30')
  })
})

describe('launching against a pin', () => {
  class FakeBrowser implements BrowserHandle {
    readonly pid = 4242
    readonly wsEndpoint = 'ws://127.0.0.1:9999/vfox'
    async close(): Promise<void> {}
    onExit(_listener: (exit: BrowserExit) => void): void {}
  }

  function registryFor(profiles: Profile[], launch: BrowserLauncher) {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const registry = new RuntimeRegistry({
      launch,
      resolveProfile: async id => profiles.find(item => item.id === id),
      resolveKernel: async item =>
        resolveKernelForProfile({
          profile: item,
          kernels: await listInstalledKernels(root, { withSize: false }),
          preferred: PREFERRED,
        }),
      userDataDir: id => path.join(dataDir, 'profiles', id, 'userdata'),
      profileIds: async () => profiles.map(item => item.id),
      logger: log,
    })
    return { registry, log }
  }

  it('hands the pinned kernel directory to the launcher', async () => {
    await versionedKernel(PREFERRED)
    await versionedKernel(OTHER)
    const launch = vi.fn<BrowserLauncher>(async () => new FakeBrowser())
    const { registry } = registryFor([profile({ kernel: OTHER })], launch)

    await registry.launch('p1')

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0].engineDir).toBe(
      path.join(kernelLayout(root).kernelsDir, OTHER),
    )
  })

  it('refuses before spawning anything, and records a code the GUI can act on', async () => {
    await versionedKernel(PREFERRED)
    const launch = vi.fn<BrowserLauncher>(async () => new FakeBrowser())
    const { registry } = registryFor([profile({ kernel: OTHER })], launch)

    await expect(registry.launch('p1')).rejects.toThrow('which is not installed')

    expect(launch).not.toHaveBeenCalled()
    const runtime = registry.get('p1')
    expect(runtime.status).toBe('error')
    expect(runtime.errorCode).toBe('kernel_missing')
    expect(runtime.lastError).toContain(`pinned to engine ${OTHER}`)
    expect(runtime.pid).toBeNull()
  })

  it('logs a warning when an unpinned profile launches on a different engine', async () => {
    await versionedKernel(PREFERRED)
    const launch = vi.fn<BrowserLauncher>(async () => new FakeBrowser())
    const { registry, log } = registryFor(
      [profile({ identity: { version: 1, engine: OTHER, generatedAt: '', fingerprint: {} } })],
      launch,
    )

    await registry.launch('p1')

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`created on engine ${OTHER}`))
    expect(launch.mock.calls[0]?.[0].engineDir).toBe(
      path.join(kernelLayout(root).kernelsDir, PREFERRED),
    )
  })
})

describe('an old-shaped store', () => {
  it('loads with no kernel pin and still launches on the installed kernel', async () => {
    await versionedKernel(PREFERRED)
    // Written by the version before this feature: no `kernel` key at all, an identity, a fingerprint.
    await fs.writeFile(
      path.join(dataDir, 'profiles.json'),
      JSON.stringify([
        {
          id: 'legacy-1',
          name: 'Legacy fleet 01',
          groupId: null,
          notes: '',
          color: null,
          proxy: null,
          fingerprint: { os: 'windows', config: {} },
          identity: {
            version: 1,
            engine: null,
            generatedAt: '2024-01-01T00:00:00.000Z',
            fingerprint: { navigator: { userAgent: 'Mozilla/5.0' } },
          },
          launch: { headless: false, startUrl: null },
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ]),
      'utf8',
    )

    const store = new Store(dataDir)
    await store.load()
    const [loaded] = await store.listProfiles()

    // The schema fills the pin in rather than rejecting the row...
    expect(loaded?.kernel).toBeNull()
    // ...and the resolver turns "no pin" into the installed kernel rather than an error.
    const resolution = resolveKernelForProfile({
      profile: loaded as Profile,
      kernels: await listInstalledKernels(root, { withSize: false }),
      preferred: PREFERRED,
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('expected the legacy profile to resolve')
    expect(resolution.dir).toBe(path.join(kernelLayout(root).kernelsDir, PREFERRED))

    // And the whole launch path agrees: the launcher is handed that kernel directory.
    const launch = vi.fn<BrowserLauncher>(async () => ({
      pid: 1,
      wsEndpoint: 'ws://127.0.0.1:1/x',
      close: async () => {},
      onExit: () => {},
    }))
    const registry = new RuntimeRegistry({
      launch,
      resolveProfile: async id => store.getProfile(id),
      resolveKernel: async item =>
        resolveKernelForProfile({
          profile: item,
          kernels: await listInstalledKernels(root, { withSize: false }),
          preferred: PREFERRED,
        }),
      userDataDir: id => store.userDataDir(id),
      profileIds: () => store.profileIds(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    await registry.launch('legacy-1')

    expect(launch.mock.calls[0]?.[0].engineDir).toBe(
      path.join(kernelLayout(root).kernelsDir, PREFERRED),
    )
  })
})

describe('the launchOptions call sites', () => {
  /** The compiled test build sits beside the compiled sources; find them without hard-coding depth. */
  async function findSrcDir(): Promise<string> {
    let dir = import.meta.dirname
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = path.join(dir, 'src')
      try {
        await fs.access(path.join(candidate, 'launcher.ts'))
        return candidate
      } catch {
        dir = path.dirname(dir)
      }
    }
    throw new Error('could not locate packages/core/src from the test build')
  }

  it('are exactly one, and it passes an explicit executable path', async () => {
    // The guard the Lead asked for. Any second call site can silently re-open the download hole that
    // `packages/core/docs/engine-kernels.md` §1.1 measures — 10 outbound requests from one launch when
    // the engine directory looks uninstalled — so a future call site must fail here, in CI, rather
    // than be noticed in review.
    const srcDir = await findSrcDir()
    const callSites: { file: string; args: string }[] = []

    for (const file of await fs.readdir(srcDir)) {
      if (!file.endsWith('.ts')) continue
      const text = await fs.readFile(path.join(srcDir, file), 'utf8')
      // An actual call, not a mention in a comment: `await launchOptions(`.
      const call = /await\s+launchOptions\(/.exec(text)
      if (call) {
        const end = text.indexOf('}))', call.index)
        callSites.push({
          file,
          args: text.slice(call.index, end === -1 ? call.index + 400 : end),
        })
      }
    }

    expect(callSites.map(site => site.file)).toEqual(['launcher.ts'])
    expect(callSites[0]?.args).toContain('executable_path')
    expect(callSites[0]?.args).toContain('engineDirOverride')
  })
})
