/**
 * A tiny rotating log file, so a user who hits a problem has something to send.
 *
 * It lives in `<dataDir>/logs`, which means it travels with a portable folder. This is a local
 * file and nothing else: no upload, no crash reporter, no telemetry.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const MAX_BYTES = 2 * 1024 * 1024

function describe(args: unknown[]): string {
  if (args.length === 0) return ''
  return ` ${args
    .map(arg => {
      if (arg instanceof Error) return arg.stack ?? arg.message
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')}`
}

export function createFileLogger(logDir: string): Logger {
  const file = join(logDir, 'vfox.log')

  const rotate = (): void => {
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // No file yet, or it is locked: appending anyway is fine.
    }
  }

  const write = (level: string, msg: string, args: unknown[]): void => {
    const line = `${new Date().toISOString()} ${level} ${msg}${describe(args)}\n`
    try {
      mkdirSync(logDir, { recursive: true })
      rotate()
      appendFileSync(file, line, 'utf8')
    } catch {
      // A log that cannot be written must never take the app down.
    }
  }

  return {
    debug: (msg, ...args) => {
      console.debug(`[vfox] ${msg}`, ...args)
      write('DEBUG', msg, args)
    },
    info: (msg, ...args) => {
      console.info(`[vfox] ${msg}`, ...args)
      write('INFO ', msg, args)
    },
    warn: (msg, ...args) => {
      console.warn(`[vfox] ${msg}`, ...args)
      write('WARN ', msg, args)
    },
    error: (msg, ...args) => {
      console.error(`[vfox] ${msg}`, ...args)
      write('ERROR', msg, args)
    },
  }
}
