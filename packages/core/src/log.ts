/**
 * Rotating file log.
 *
 * VFox ships zero telemetry, so this file is the only debugging channel the product has: the GUI's
 * "copy diagnostics" button reads it, and support asks for it. It is written by the core itself and
 * additionally forwarded to whatever logger the embedding application supplied.
 *
 * `<dataDir>/logs/vfox.log`, rotated at 2 MB, five generations kept. Logging never throws and never
 * blocks the caller: writes are queued, and a failed write is dropped rather than propagated (there
 * is nowhere left to report it).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { CoreLogger } from './index.js'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5

export function logFilePath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'vfox.log')
}

export function createFileLogger(
  dataDir: string,
  options: { maxBytes?: number; maxFiles?: number } = {},
): CoreLogger {
  const file = logFilePath(dataDir)
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const maxFiles = options.maxFiles ?? MAX_FILES
  let queue: Promise<void> = Promise.resolve()
  let size: number | null = null

  const write = (level: string, message: string, args: unknown[]): void => {
    queue = queue.then(async () => {
      try {
        const line = `${new Date().toISOString()} ${level} ${message}${formatArgs(args)}\n`
        const bytes = Buffer.byteLength(line, 'utf8')
        size ??= await currentSize(file)
        if (size + bytes > maxBytes) {
          await rotate(file, maxFiles)
          size = 0
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, line, 'utf8')
        size += bytes
      } catch {
        // Dropped on purpose: a log write must never break the caller.
      }
    })
  }

  return {
    debug: (message, ...args) => write('DEBUG', message, args),
    info: (message, ...args) => write('INFO ', message, args),
    warn: (message, ...args) => write('WARN ', message, args),
    error: (message, ...args) => write('ERROR', message, args),
  }
}

/** Send every record to both loggers; either may be missing. */
export function combineLoggers(...loggers: (CoreLogger | undefined)[]): CoreLogger {
  const targets = loggers.filter((logger): logger is CoreLogger => logger !== undefined)
  const forward = (method: keyof CoreLogger) => (message: string, ...args: unknown[]) => {
    for (const target of targets) {
      try {
        target[method](message, ...args)
      } catch {
        // A broken consumer logger must not break the caller either.
      }
    }
  }
  return {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  }
}

async function currentSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

/** vfox.log -> vfox.1.log -> ... -> vfox.<maxFiles-1>.log; the oldest is dropped. */
async function rotate(file: string, maxFiles: number): Promise<void> {
  const extension = path.extname(file)
  const stem = file.slice(0, -extension.length)
  await fs.rm(`${stem}.${maxFiles - 1}${extension}`, { force: true })
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    try {
      await fs.rename(`${stem}.${index}${extension}`, `${stem}.${index + 1}${extension}`)
    } catch {
      // A missing generation is normal while the log is still filling up.
    }
  }
  try {
    await fs.rename(file, `${stem}.1${extension}`)
  } catch {
    // Nothing to rotate yet.
  }
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) {
    return ''
  }
  return ` ${args.map(formatArg).join(' ')}`
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`
  }
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}
