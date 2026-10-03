/**
 * Output helpers: human-readable tables by default, machine-readable JSON on `--json`.
 *
 * Everything a command prints goes through here so `--json` can never be polluted by a stray
 * `console.log`, and so progress lines stay on stderr where they cannot corrupt piped stdout.
 */

import type { CoreLogger } from '@vfox/core'

export interface Column<T> {
  readonly header: string
  readonly value: (row: T) => string
}

export interface Output {
  readonly json: boolean
  /** stdout, for data. */
  line(text?: string): void
  /** stderr, for progress and warnings. */
  note(text: string): void
  table<T>(rows: readonly T[], columns: readonly Column<T>[]): void
  /** JSON when `--json`, otherwise the supplied human text. */
  result(value: unknown, human: () => void): void
}

export function createOutput(json: boolean): Output {
  const out = process.stdout
  const err = process.stderr
  return {
    json,
    line: (text = '') => out.write(`${text}\n`),
    note: text => err.write(`${text}\n`),
    result: (value, human) => {
      if (json) out.write(`${JSON.stringify(value, null, 2)}\n`)
      else human()
    },
    table: (rows, columns) => {
      if (rows.length === 0) {
        out.write('(none)\n')
        return
      }
      const cells = rows.map(row => columns.map(column => sanitize(column.value(row))))
      const widths = columns.map((column, index) =>
        Math.max(column.header.length, ...cells.map(row => row[index]?.length ?? 0)),
      )
      const render = (row: readonly string[]): string =>
        row
          .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
          .join('  ')
          .trimEnd()

      out.write(`${render(columns.map(column => column.header))}\n`)
      out.write(`${widths.map(width => '-'.repeat(width)).join('  ')}\n`)
      for (const row of cells) out.write(`${render(row)}\n`)
    },
  }
}

/** Tables must survive a value that is missing, null or multi-line. */
function sanitize(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return value.replace(/\s+/g, ' ').trim() || '-'
}

/**
 * A logger that only ever writes to stderr.
 *
 * `vfox mcp` speaks the MCP protocol over stdout, so a single stray byte there corrupts the
 * session. Every diagnostic in this package goes to stderr for that reason.
 */
export function createStderrLogger(prefix = '[vfox]'): CoreLogger {
  const write = (level: string, message: string, args: unknown[]): void => {
    const rest = args.length > 0 ? ` ${args.map(format).join(' ')}` : ''
    process.stderr.write(`${prefix} ${level} ${message}${rest}\n`)
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
