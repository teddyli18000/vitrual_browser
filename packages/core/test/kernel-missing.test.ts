/**
 * Issue #102: the launch path must not decide from a stale list.
 *
 * The measurement that opened the issue, from the review of #94:
 *
 *   -- what the resolver is given --
 *     listInstalledKernels       152.0.4-beta.30
 *     resolveKernelForProfile    REFUSED kernel_missing
 *   -- what runtime.launch does --
 *     threw: ... has no camoufox.exe. Reinstall that kernel from Settings -> Engine, ...
 *     runtime.errorCode          null        <- not 'kernel_missing'
 *
 * The resolver was right and the launch path was wrong, because it handed it a list memoised per
 * process and cleared only by our own install/remove. So `kernel.info()`, which re-lists, reported the
 * kernel gone while the launch still believed it was installed — two halves of one process disagreeing
 * — and the GUI cannot branch on a code that is always `null`, so it could not offer the one action
 * that fixes the situation.
 *
 * The first case is the discriminator: delete `kernels/<version>` between a list and a launch. It fails
 * on the memoised implementation (`errorCode: null`, and the launcher's message rather than the
 * resolver's) and passes on the re-listing one. Both directions were measured locally over the built
 * `dist/` before this file existed, because vitest cannot run in the development sandbox — `vite`
 * spawns a child with a pipe and the sandbox forbids it. CI is where this file first runs.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Core, createCore } from '../src/index.js'
import { kernelLauncherName } from '../src/kernels.js'

const VERSION = '152.0.4-beta.30'

let root: string
let dataDir: string
let engineRoot: string
let previousEngineDir: string | undefined

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-kernel-missing-'))
  dataDir = path.join(root, 'data')
  engineRoot = path.join(root, 'engine')
  // A test that reads the machine is a coin flip: this one owns the engine root it measures.
  previousEngineDir = process.env.CAMOUFOX_INSTALL_DIR
  process.env.CAMOUFOX_INSTALL_DIR = engineRoot
})

afterEach(async () => {
  if (previousEngineDir === undefined) delete process.env.CAMOUFOX_INSTALL_DIR
  else process.env.CAMOUFOX_INSTALL_DIR = previousEngineDir
  await fs.rm(root, { recursive: true, force: true })
})

/** A kernel build the resolver will accept: launcher, version marker, and the engine's property table. */
async function writeKernel(version: string): Promise<string> {
  const dir = path.join(engineRoot, 'kernels', version)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, kernelLauncherName()), 'stub')
  await fs.writeFile(path.join(dir, 'properties.json'), '[]')
  const [number, release] = version.split('-')
  await fs.writeFile(
    path.join(dir, 'version.json'),
    JSON.stringify({ version: number, release: release ?? '' }),
  )
  return dir
}

describe('a pinned kernel that disappears while the app is running', () => {
  it('refuses the launch with kernel_missing, not with the launcher’s own error', async () => {
    const kernelDir = await writeKernel(VERSION)
    const core: Core = await createCore({ dataDir, kernelDir: engineRoot })

    const profile = await core.profiles.create({ name: 'Memo probe', kernel: VERSION })
    expect(profile.kernel).toBe(VERSION)

    // The list the launch path used to memoise. `kernel.info()` re-lists, so from here the two halves
    // of the process can only agree if the launch path re-lists too.
    expect((await core.kernel.info()).kernels.map(kernel => kernel.version)).toEqual([VERSION])

    await fs.rm(kernelDir, { recursive: true, force: true })
    expect((await core.kernel.info()).kernels).toEqual([])

    // The resolver's refusal names the pin; the launcher's names a missing executable. Asserting the
    // message as well as the code is what distinguishes the two, and the code is what the GUI needs.
    await expect(core.runtime.launch(profile.id)).rejects.toThrow(/pinned to engine/)
    const runtime = await core.runtime.get(profile.id)
    expect(runtime?.errorCode).toBe('kernel_missing')
    // The refusal happens before anything is spawned, so there is no pid to report.
    expect(runtime?.pid).toBeNull()
  })

  it('sees a kernel that appeared while the app was running', async () => {
    // The staleness ran the other way too: a kernel the CLI installed while the app was up was
    // invisible, so a profile pinned to it was told to install something that was already there.
    const core: Core = await createCore({ dataDir, kernelDir: engineRoot })
    await core.profiles.create({ name: 'Late kernel', kernel: VERSION })
    expect((await core.kernel.info()).kernels).toEqual([])

    await writeKernel(VERSION)

    expect((await core.kernel.info()).kernels.map(kernel => kernel.version)).toEqual([VERSION])
  })
})
