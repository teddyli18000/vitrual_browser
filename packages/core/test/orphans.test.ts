import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileOrphans, type EngineProcess } from '../src/orphans.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-orphans-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function makeProfile(id: string, withLock: boolean): Promise<string> {
  const dir = path.join(dataDir, 'profiles', id)
  await fs.mkdir(path.join(dir, 'userdata'), { recursive: true })
  if (withLock) {
    await fs.writeFile(path.join(dir, 'parent.lock'), '')
  }
  return dir
}

function engineProcess(pid: number, profileId: string): EngineProcess {
  return {
    pid,
    commandLine: `C:\\engine\\camoufox.exe -no-remote -profile ${path.join(dataDir, 'profiles', profileId, 'userdata')} -juggler-pipe`,
  }
}

describe('reconcileOrphans', () => {
  it('does nothing at all when no profile holds a lock', async () => {
    await makeProfile('a', false)
    const listProcesses = vi.fn(async () => [])
    const log = logger()

    const result = await reconcileOrphans({ dataDir, logger: log, listProcesses })

    expect(result).toEqual({ killed: [], locksRemoved: [], checked: false })
    // The common path must not shell out to enumerate processes.
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('kills engine processes from a previous run and removes their stale locks', async () => {
    await makeProfile('a', true)
    await makeProfile('b', true)
    const processes = [engineProcess(100, 'a'), engineProcess(200, 'b')]
    const killTree = vi.fn()
    const log = logger()
    let call = 0

    const result = await reconcileOrphans({
      dataDir,
      logger: log,
      // The first enumeration finds the orphans; the verification pass finds nothing left.
      listProcesses: async () => (call++ === 0 ? processes : []),
      killTree,
    })

    expect(result.killed).toEqual([100, 200])
    expect(killTree.mock.calls.map(args => args[0])).toEqual([100, 200])
    expect(result.locksRemoved).toHaveLength(2)
    await expect(fs.access(path.join(dataDir, 'profiles', 'a', 'parent.lock'))).rejects.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })

  it('keeps a lock while a live engine process still owns the profile', async () => {
    await makeProfile('a', true)
    const killTree = vi.fn()

    const result = await reconcileOrphans({
      dataDir,
      logger: logger(),
      listProcesses: async () => [engineProcess(100, 'a')],
      killTree,
    })

    expect(killTree).not.toHaveBeenCalled()
    expect(result.locksRemoved).toEqual([])
    expect(await fs.readFile(path.join(dataDir, 'profiles', 'a', 'parent.lock'), 'utf8')).toBe('')
  })

  it('ignores engine processes that belong to another data directory', async () => {
    await makeProfile('a', true)
    const foreign: EngineProcess = {
      pid: 999,
      commandLine: 'C:\\engine\\camoufox.exe -profile C:\\other\\vfox\\profiles\\x\\userdata',
    }
    const killTree = vi.fn()

    const result = await reconcileOrphans({
      dataDir,
      logger: logger(),
      listProcesses: async () => [foreign],
      killTree,
    })

    expect(result.killed).toEqual([])
    expect(killTree).not.toHaveBeenCalled()
    expect(result.locksRemoved).toHaveLength(1)
  })

  it('never removes a lock when processes cannot be enumerated', async () => {
    await makeProfile('a', true)
    const log = logger()

    const result = await reconcileOrphans({
      dataDir,
      logger: log,
      listProcesses: async () => null,
    })

    expect(result.checked).toBe(true)
    expect(result.locksRemoved).toEqual([])
    expect(log.warn).toHaveBeenCalled()
    expect(await fs.readFile(path.join(dataDir, 'profiles', 'a', 'parent.lock'), 'utf8')).toBe('')
  })

  it('never touches the profile directory itself', async () => {
    const dir = await makeProfile('a', true)
    await fs.writeFile(path.join(dir, 'userdata', 'cookies.sqlite'), 'data')

    await reconcileOrphans({ dataDir, logger: logger(), listProcesses: async () => [] })

    expect(await fs.readFile(path.join(dir, 'userdata', 'cookies.sqlite'), 'utf8')).toBe('data')
    await expect(fs.access(dir)).resolves.toBeUndefined()
  })

  it('is a no-op before any profile exists', async () => {
    const listProcesses = vi.fn(async () => [])
    const result = await reconcileOrphans({ dataDir, logger: logger(), listProcesses })

    expect(result.checked).toBe(false)
    expect(listProcesses).not.toHaveBeenCalled()
  })
})
