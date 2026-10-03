import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { combineLoggers, createFileLogger, logFilePath } from '../src/log.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-log-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Writes are queued, so wait for the last one to land instead of guessing a delay. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function readLog(dataDir: string): Promise<string> {
  await waitFor(async () => {
    try {
      return (await fs.readFile(logFilePath(dataDir), 'utf8')).includes('\n')
    } catch {
      return false
    }
  })
  return fs.readFile(logFilePath(dataDir), 'utf8')
}

describe('createFileLogger', () => {
  it('writes the level, the message and the arguments to <dataDir>/logs/vfox.log', async () => {
    const logger = createFileLogger(dataDir)

    logger.info('profile created', { id: 'p1' })
    logger.error('launch failed', new Error('spawn EPERM'))

    const contents = await readLog(dataDir)
    expect(contents).toMatch(/INFO {2}profile created \{"id":"p1"\}/)
    expect(contents).toMatch(/ERROR launch failed Error: spawn EPERM/)
    expect(contents.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /)
  })

  it('rotates at the size limit and keeps a bounded number of files', async () => {
    const logger = createFileLogger(dataDir, { maxBytes: 200, maxFiles: 3 })

    for (let index = 0; index < 40; index += 1) {
      logger.info(`line ${index} ${'x'.repeat(60)}`)
    }
    await waitFor(async () => {
      try {
        return (await fs.readFile(logFilePath(dataDir), 'utf8')).includes('line 39')
      } catch {
        return false
      }
    })

    const files = (await fs.readdir(path.join(dataDir, 'logs'))).sort()
    expect(files).toEqual(['vfox.1.log', 'vfox.2.log', 'vfox.log'])
    expect(await fs.readFile(logFilePath(dataDir), 'utf8')).toContain('line 39')
  })

  it('never throws, even when the log cannot be written', async () => {
    // A file where the log directory should be: every write must fail, and be swallowed.
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'logs'), 'not a directory')
    const logger = createFileLogger(dataDir)

    expect(() => logger.error('still fine')).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 20))
  })
})

describe('combineLoggers', () => {
  it('forwards every level to every logger', () => {
    const first = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const second = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const combined = combineLoggers(first, second)

    combined.warn('careful', 1)
    combined.debug('noise')

    expect(first.warn).toHaveBeenCalledWith('careful', 1)
    expect(second.warn).toHaveBeenCalledWith('careful', 1)
    expect(first.debug).toHaveBeenCalledWith('noise')
    expect(second.debug).toHaveBeenCalledWith('noise')
  })

  it('survives a consumer logger that throws, and accepts undefined', () => {
    const broken = {
      debug: vi.fn(() => {
        throw new Error('broken consumer')
      }),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const combined = combineLoggers(undefined, broken)

    expect(() => combined.debug('x')).not.toThrow()
    expect(broken.debug).toHaveBeenCalled()
  })
})
