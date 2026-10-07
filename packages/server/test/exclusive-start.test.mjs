import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCore } from '@vfox/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from '../dist/index.js'

let dataDir

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'vfox-exclusive-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/**
 * `requireExclusive` is the desktop's path, and the only one that guarantees a single writer.
 *
 * Two instances on one data directory mean two writers and two browsers on one profile directory, so
 * the desktop must not start at all rather than start read-only and present a window whose buttons
 * fail. The CLI and the server leave the flag unset, which is why the second case here matters: a
 * read-only command beside the GUI is the documented workflow and must keep working.
 */
describe('requireExclusive', () => {
  it('refuses to start when another live instance owns the data directory, naming it', async () => {
    const owner = await createCore({ dataDir })
    try {
      await expect(startServer({ dataDir, requireExclusive: true })).rejects.toThrow(
        /VFox is already running \(pid \d+\)/,
      )
    } finally {
      await owner.close()
    }
  })

  it('starts read-only when the flag is not set, so a CLI may run beside the GUI', async () => {
    const owner = await createCore({ dataDir })
    let handle = null
    try {
      handle = await startServer({ dataDir, port: 0 })
      expect(handle.port).toBeGreaterThan(0)
      // The owner still holds the directory: the server did not take it.
      expect((await owner.profiles.list()).length).toBe(0)
    } finally {
      await handle?.close()
      await owner.close()
    }
  })
})
