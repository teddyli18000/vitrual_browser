/**
 * Rotating log file at `<dataDir>/logs/vfox.log`.
 *
 * The desktop app's "copy diagnostics" action reads this file, so it must contain the things a
 * support request actually needs: the port the API bound, whether a token is configured (never the
 * token itself), lifecycle events and every rejected request with method, path and status.
 *
 * Implemented with `appendFileSync` rather than a stream: the volume is a handful of lines per
 * session, synchronous appends keep ordering obvious and cannot be lost on an abrupt exit, and it
 * keeps the process free of another long-lived handle. Every call is wrapped — a logging failure
 * must never turn into a failed request.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import type { CoreLogger } from '@vfox/core'

export const LOG_DIR_NAME = 'logs'
export const LOG_FILE_NAME = 'vfox.log'
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
/** Total files kept, including the live one: `vfox.log` + `vfox.log.1` .. `vfox.log.4`. */
export const DEFAULT_MAX_FILES = 5

export function logFilePath(dataDir: string): string {
  return path.join(dataDir, LOG_DIR_NAME, LOG_FILE_NAME)
}

export interface RotatingLoggerOptions {
  dataDir: string
  maxBytes?: number
  maxFiles?: number
}

export function createRotatingLogger(options: RotatingLoggerOptions): CoreLogger {
  const file = logFilePath(options.dataDir)
  const dir = path.dirname(file)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)

  let size = 0
  try {
    mkdirSync(dir, { recursive: true })
    size = statSync(file).size
  } catch {
    size = 0
  }

  const rotate = (): void => {
    try {
      const generations = maxFiles - 1
      rmSync(`${file}.${generations}`, { force: true })
      for (let index = generations - 1; index >= 1; index -= 1) {
        const from = `${file}.${index}`
        if (existsSync(from)) renameSync(from, `${file}.${index + 1}`)
      }
      if (existsSync(file)) renameSync(file, `${file}.1`)
    } catch {
      // Rotation is best-effort: a locked file must not break the request that triggered it.
    }
    size = 0
  }

  const write = (level: string, message: string, args: unknown[]): void => {
    const rest = args.length > 0 ? ` ${args.map(format).join(' ')}` : ''
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${rest}\n`
    try {
      const bytes = Buffer.byteLength(line, 'utf8')
      if (size + bytes > maxBytes) rotate()
      appendFileSync(file, line, 'utf8')
      size += bytes
    } catch {
      // Never propagate: diagnostics are not worth a failed request.
    }
  }

  return {
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
  }
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
