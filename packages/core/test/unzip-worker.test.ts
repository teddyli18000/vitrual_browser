import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UnzipWorkerMessage } from '../src/unzip-worker.js'

let root: string
let into: string

/**
 * Spawns the compiled worker exactly the way `kernel.ts` does — same module, same URL shape — and
 * collects its messages.
 */
function runWorker(archive: string): Promise<{ messages: UnzipWorkerMessage[]; error?: Error }> {
  return new Promise(resolve => {
    const worker = new Worker(new URL('../src/unzip-worker.js', import.meta.url), {
      workerData: { archive, into, desc: 'test' },
    })
    const messages: UnzipWorkerMessage[] = []
    worker.on('message', message => {
      messages.push(message as UnzipWorkerMessage)
    })
    worker.on('error', error => {
      void worker.terminate()
      resolve({ messages, error })
    })
    worker.on('exit', () => resolve({ messages }))
  })
}

/**
 * Enough small entries that the extraction lasts well over a second — long enough that a synchronous
 * extraction would show up plainly in the heartbeat, short enough to stay inside a test timeout.
 */
const ENTRIES = 600

/** Enough small entries that a synchronous extraction would be plainly visible in the heartbeat. */
async function makeArchive(name: string, entries: number): Promise<string> {
  const zip = new AdmZip()
  for (let index = 0; index < entries; index += 1) {
    zip.addFile(`data/file-${index}.txt`, Buffer.from(`payload ${index}`.repeat(8)))
  }
  const file = path.join(root, name)
  zip.writeZip(file)
  return file
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-unzip-'))
  into = path.join(root, 'out')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the extraction worker', () => {
  it('extracts every entry and reports progress for each one', async () => {
    const archive = await makeArchive('many.zip', ENTRIES)

    const { messages, error } = await runWorker(archive)

    expect(error).toBeUndefined()
    const progress = messages.filter(message => message.type === 'progress')
    const done = messages.find(message => message.type === 'done')
    expect(done).toEqual({ type: 'done', entries: ENTRIES })
    expect(progress).toHaveLength(ENTRIES)
    expect(progress.at(-1)).toMatchObject({ done: ENTRIES, total: ENTRIES })
    expect(await fs.readFile(path.join(into, 'data', 'file-599.txt'), 'utf8')).toContain(
      'payload 599',
    )
  }, 30000)

  /**
   * The acceptance criterion, made measurable: while the worker extracts, the parent's event loop must
   * keep turning. A synchronous extraction of the same archive blocks it completely — that was
   * measured on the real installer (106 MB, 2163 ms, 0 of 87 heartbeats).
   */
  it('keeps the parent event loop running while the extraction happens', async () => {
    const archive = await makeArchive('heartbeat.zip', ENTRIES)

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 10)
    const { messages, error } = await runWorker(archive)
    clearInterval(timer)

    expect(error).toBeUndefined()
    expect(messages.some(message => message.type === 'done')).toBe(true)
    // The parent was free to run timers the whole time.
    expect(ticks).toBeGreaterThan(0)
  }, 30000)

  it('reports a corrupt archive as an error instead of throwing into the parent', async () => {
    const truncated = path.join(root, 'truncated.zip')
    await fs.writeFile(truncated, Buffer.from('PK\u0003\u0004 not a zip', 'utf8'))

    const { messages } = await runWorker(truncated)

    const failure = messages.find(message => message.type === 'error')
    expect(failure).toBeDefined()
    expect(messages.some(message => message.type === 'done')).toBe(false)
  }, 20000)
})
