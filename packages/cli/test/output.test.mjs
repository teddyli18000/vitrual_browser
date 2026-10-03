import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOutput } from '../dist/output.js'

let written

beforeEach(() => {
  written = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const text = () => written.join('')

describe('createOutput', () => {
  it('prints a padded table with a header rule', () => {
    const output = createOutput(false)
    output.table(
      [
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', name: 'A much longer name' },
      ],
      [
        { header: 'ID', value: (row) => row.id },
        { header: 'NAME', value: (row) => row.name },
      ],
    )

    const lines = text().trimEnd().split('\n')
    expect(lines[0]).toBe('ID  NAME')
    expect(lines[1]).toBe('--  ------------------')
    expect(lines[2]).toBe('p1  Alpha')
    expect(lines[3]).toBe('p2  A much longer name')
  })

  it('renders missing values as a dash and flattens whitespace', () => {
    const output = createOutput(false)
    output.table([{ id: 'p1', name: null, note: 'two\nlines' }], [
      { header: 'ID', value: (row) => row.id },
      { header: 'NAME', value: (row) => row.name },
      { header: 'NOTE', value: (row) => row.note },
    ])
    expect(text()).toContain('p1  -  two lines')
  })

  it('says (none) for an empty table', () => {
    createOutput(false).table([], [{ header: 'ID', value: (row) => row.id }])
    expect(text()).toBe('(none)\n')
  })

  it('prints JSON with --json instead of the human text', () => {
    const output = createOutput(true)
    output.result({ a: 1 }, () => output.line('human'))
    expect(text()).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`)
  })

  it('prints the human text without --json', () => {
    const output = createOutput(false)
    output.result({ a: 1 }, () => output.line('human'))
    expect(text()).toBe('human\n')
  })
})
