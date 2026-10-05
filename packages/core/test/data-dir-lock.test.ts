import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Core, createCore } from '../src/index.js'

let dataDir: string
const cores: Core[] = []

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-lock-'))
})

afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.close()
  }
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function openCore(): Promise<Core> {
  const core = await createCore({ dataDir })
  cores.push(core)
  return core
}

/**
 * The data-directory lock, from the outside.
 *
 * `acquireDataDirLock` was a *reconciliation-ownership marker*: a live pid produced a warning and
 * skipped orphan reconciliation, and nothing stopped the second process from writing `profiles.json`
 * or from launching a profile the first one already had open. Two browsers on one profile directory is
 * the corruption the lock exists to prevent, and it is not a lost write — it is a profile whose state
 * the user cannot diagnose.
 *
 * Reads pass, writes refuse. A read-only command alongside the GUI is the documented workflow
 * (`store.ts:50-51`) and must keep working; a write from a second instance must not.
 */
describe('the data-directory lock', () => {
  it('refuses writes from a second core on the same data directory', async () => {
    const first = await openCore()
    const created = await first.profiles.create({ name: 'owned by the first' })

    const second = await openCore()

    // Reads pass: a CLI may look at the store while the GUI owns it.
    expect((await second.profiles.list()).map(profile => profile.id)).toContain(created.id)

    // Writes refuse, and the message names what holds the directory.
    await expect(second.profiles.create({ name: 'from the second instance' })).rejects.toThrow(
      /pid \d+/,
    )
    await expect(second.profiles.remove(created.id)).rejects.toThrow(/pid \d+/)
    await expect(
      second.profiles.update(created.id, { name: 'renamed by the second' }),
    ).rejects.toThrow(/pid \d+/)

    // The corruption path specifically: the second instance must not put a browser on a profile the
    // owner may already have open.
    await expect(second.runtime.launch(created.id)).rejects.toThrow(/pid \d+/)

    // And the owner is unaffected.
    expect((await first.profiles.list()).map(profile => profile.name)).toEqual([
      'owned by the first',
    ])
  })

  it('takes over from a holder that is no longer running', async () => {
    // A lock left behind by a crashed process: the pid is real but nothing is listening.
    await fs.writeFile(
      path.join(dataDir, 'core.lock'),
      `${JSON.stringify({ pid: 999_999, startedAt: '2024-01-01T00:00:00.000Z' })}\n`,
      'utf8',
    )

    const core = await openCore()

    // A stale lock must never lock the user out — that would be worse than the bug being fixed.
    await expect(core.profiles.create({ name: 'after the crash' })).resolves.toBeTruthy()
  })
})
