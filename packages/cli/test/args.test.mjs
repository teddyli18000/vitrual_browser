import { describe, expect, it } from 'vitest'

import { parseArgs, renderFlags, requirePositional, UsageError } from '../dist/args.js'

const FLAGS = [
  { name: 'json', kind: 'boolean', description: 'json output' },
  { name: 'name', kind: 'string', description: 'a name' },
  { name: 'yes', kind: 'boolean', description: 'confirm' },
]

describe('parseArgs', () => {
  it('collects positionals', () => {
    const parsed = parseArgs(['alpha', 'beta'], FLAGS)
    expect(parsed.positionals).toEqual(['alpha', 'beta'])
  })

  it('parses boolean flags', () => {
    const parsed = parseArgs(['--json', 'alpha'], FLAGS)
    expect(parsed.has('json')).toBe(true)
    expect(parsed.positionals).toEqual(['alpha'])
  })

  it('parses string flags in both spellings', () => {
    expect(parseArgs(['--name', 'beta'], FLAGS).get('name')).toBe('beta')
    expect(parseArgs(['--name=beta'], FLAGS).get('name')).toBe('beta')
  })

  it('treats --json=false as absent', () => {
    expect(parseArgs(['--json=false'], FLAGS).has('json')).toBe(false)
    expect(parseArgs(['--json=true'], FLAGS).has('json')).toBe(true)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs(['--nope'], FLAGS)).toThrow(UsageError)
    expect(() => parseArgs(['--nope'], FLAGS)).toThrow(/Unknown option --nope/)
  })

  it('rejects a string flag without a value', () => {
    expect(() => parseArgs(['--name'], FLAGS)).toThrow(/requires a value/)
    expect(() => parseArgs(['--name', '--json'], FLAGS)).toThrow(/requires a value/)
  })

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['--json=maybe'], FLAGS)).toThrow(/does not take a value/)
  })

  it('stops parsing flags after --', () => {
    const parsed = parseArgs(['--json', '--', '--name'], FLAGS)
    expect(parsed.has('json')).toBe(true)
    expect(parsed.positionals).toEqual(['--name'])
    expect(parsed.get('name')).toBeUndefined()
  })

  it('accepts -h as help', () => {
    expect(parseArgs(['-h'], FLAGS).has('help')).toBe(true)
  })

  it('allows an empty value with =', () => {
    expect(parseArgs(['--name='], FLAGS).get('name')).toBe('')
  })
})

describe('requirePositional', () => {
  it('returns the value', () => {
    expect(requirePositional(parseArgs(['alpha'], FLAGS), 0, 'profile')).toBe('alpha')
  })

  it('throws a usage error when missing', () => {
    expect(() => requirePositional(parseArgs([], FLAGS), 0, 'profile id or name')).toThrow(
      /Missing profile id or name/,
    )
  })
})

describe('renderFlags', () => {
  it('renders name, value placeholder and description', () => {
    const text = renderFlags(FLAGS)
    expect(text).toContain('--json')
    expect(text).toContain('--name <value>')
    expect(text).toContain('a name')
  })
})
