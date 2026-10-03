/**
 * Logging.
 *
 * The product ships zero telemetry, so there is no log shipping and no analytics: messages go to
 * the local stderr/stdout of whichever process embedded the server. Fastify's own request logging
 * stays off; only lifecycle lines are emitted, through the same `CoreLogger` shape `@vfox/core`
 * accepts so the desktop app can route them into its own log view.
 */

import type { CoreLogger } from '@vfox/core'

const noop = (): void => {}

export const silentLogger: CoreLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

/** Plain-text logger. Deliberately dependency-free (no pino transport, no formatting). */
export function consoleLogger(prefix = '[vfox]'): CoreLogger {
  const write = (stream: NodeJS.WriteStream, level: string, msg: string, args: unknown[]): void => {
    const line = `${prefix} ${level} ${msg}${args.length > 0 ? ` ${args.map(stringify).join(' ')}` : ''}\n`
    stream.write(line)
  }
  return {
    debug: (msg, ...args) => write(process.stdout, 'debug', msg, args),
    info: (msg, ...args) => write(process.stdout, 'info', msg, args),
    warn: (msg, ...args) => write(process.stderr, 'warn', msg, args),
    error: (msg, ...args) => write(process.stderr, 'error', msg, args),
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
