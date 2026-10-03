/**
 * A ~90 line argument parser.
 *
 * A CLI framework would be the largest dependency in this package and would buy nothing: the
 * command surface is fixed, flat and fully described by the `FlagDef` tables below. Unknown flags
 * are rejected rather than ignored, so a typo fails loudly instead of silently doing the wrong
 * thing.
 */

export interface FlagDef {
  readonly name: string
  readonly kind: 'boolean' | 'string'
  readonly description: string
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const HELP_FLAG: FlagDef = { name: 'help', kind: 'boolean', description: 'Show help' }

export interface Parsed {
  readonly positionals: string[]
  has(name: string): boolean
  get(name: string): string | undefined
}

export function parseArgs(argv: readonly string[], defs: readonly FlagDef[]): Parsed {
  const known = new Map(defs.map((def) => [def.name, def]))
  const values = new Map<string, string | true>()
  const positionals: string[] = []
  let onlyPositionals = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue

    if (onlyPositionals) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      onlyPositionals = true
      continue
    }
    if (token === '-h') {
      values.set('help', true)
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    const def = known.get(name)
    if (!def) throw new UsageError(`Unknown option --${name}`)

    if (def.kind === 'boolean') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        throw new UsageError(`--${name} does not take a value`)
      }
      if (inline !== 'false') values.set(name, true)
      continue
    }

    if (inline !== undefined) {
      values.set(name, inline)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`--${name} requires a value`)
    }
    values.set(name, next)
    index += 1
  }

  return {
    positionals,
    has: (name) => values.has(name),
    get: (name) => {
      const value = values.get(name)
      return typeof value === 'string' ? value : undefined
    },
  }
}

export function requirePositional(parsed: Parsed, index: number, what: string): string {
  const value = parsed.positionals[index]
  if (value === undefined || value.length === 0) throw new UsageError(`Missing ${what}`)
  return value
}

export function renderFlags(defs: readonly FlagDef[]): string {
  return defs
    .map((def) => {
      const label = `  --${def.name}${def.kind === 'string' ? ' <value>' : ''}`
      return `${label.padEnd(26)}${def.description}`
    })
    .join('\n')
}
