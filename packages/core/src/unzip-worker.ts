/**
 * Extraction worker.
 *
 * `AdmZip` is synchronous — measured: 106 MB extracted in 2163 ms with **zero** 25 ms heartbeats
 * firing, i.e. the event loop was blocked for the whole extraction. At that rate the ~1 GB engine
 * freezes whatever thread runs it for ~20 seconds, which in the Electron main process is what Windows
 * reports as "not responding". This worker is that extraction moved off the main thread, so the
 * window keeps painting and the progress bar keeps moving.
 *
 * It also owns the progress reporting: `pkgman.unzip` has no hook and prints one line per file, so
 * the entry loop is driven here instead and each entry is reported to the parent.
 */

import { parentPort, workerData } from 'node:worker_threads'
import AdmZip from 'adm-zip'

export interface UnzipWorkerData {
  archive: string
  into: string
  desc: string
}

export type UnzipWorkerMessage =
  | { type: 'progress'; done: number; total: number; bytes: number; desc: string }
  | { type: 'done'; entries: number }
  | { type: 'error'; message: string }

const { archive, into, desc } = workerData as UnzipWorkerData

try {
  const zip = new AdmZip(archive)
  const entries = zip.getEntries()
  let bytes = 0
  for (const [index, entry] of entries.entries()) {
    zip.extractEntryTo(entry, into, true, true)
    bytes += entry.header.size
    // Per entry, not per byte: a real engine is ~500 entries, which is a smooth enough bar, and it
    // keeps the message volume trivial next to the I/O.
    parentPort?.postMessage({
      type: 'progress',
      done: index + 1,
      total: entries.length,
      bytes,
      desc,
    } satisfies UnzipWorkerMessage)
  }
  parentPort?.postMessage({ type: 'done', entries: entries.length } satisfies UnzipWorkerMessage)
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  } satisfies UnzipWorkerMessage)
}
