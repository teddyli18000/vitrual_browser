/**
 * `vfox cookies export|import` against a **real** `@vfox/core` and a real `cookies.sqlite`.
 *
 * This is as far as a machine that cannot launch a browser can go: the profile's cookie store is
 * created here with Firefox's own schema, so the SQLite read, the SQLite write, the file format and
 * the CLI wiring are all genuinely exercised. What it cannot show is that a browser *uses* the
 * imported cookies — that needs a launch, and therefore CI.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseJson, runCli } from './helpers/run-cli.mjs'

// Every case here creates at least one real profile, and `createIdentity` runs browserforge's
// generator each time — far slower than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const FIREFOX_SCHEMA = `
CREATE TABLE moz_cookies (
  id INTEGER PRIMARY KEY,
  originAttributes TEXT NOT NULL DEFAULT '',
  name TEXT,
  value TEXT,
  host TEXT,
  path TEXT,
  expiry INTEGER,
  lastAccessed INTEGER,
  creationTime INTEGER,
  isSecure INTEGER,
  isHttpOnly INTEGER,
  inBrowserElement INTEGER DEFAULT 0,
  sameSite INTEGER DEFAULT 0,
  rawSameSite INTEGER DEFAULT 0,
  schemeMap INTEGER DEFAULT 0,
  isPartitionedAttributeSet INTEGER DEFAULT 0,
  CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
);`

let dataDir

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-cli-cookies-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const withDir = (...args) => [...args, '--data-dir', dataDir]

async function createProfile(name = 'Alpha') {
  const result = await runCli(withDir('create', name, '--json'))
  expect(result.code).toBe(0)
  return parseJson(result.stdout)
}

/** The engine creates this on first launch; the test stands in for that launch. */
async function createCookieStore(profileId, rows = []) {
  const userDataDir = path.join(dataDir, 'profiles', profileId, 'userdata')
  await mkdir(userDataDir, { recursive: true })
  const db = new DatabaseSync(path.join(userDataDir, 'cookies.sqlite'))
  db.exec(FIREFOX_SCHEMA)
  const insert = db.prepare(
    'INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(
      row.name,
      row.value,
      row.host,
      row.path ?? '/',
      row.expiry ?? 0,
      row.secure ?? 0,
      row.httpOnly ?? 0,
    )
  }
  db.close()
}

/** Data lines only — but `#HttpOnly_…` is a cookie, not a comment. */
function cookieLines(text) {
  return text
    .split('\n')
    .filter(line => line !== '' && !(line.startsWith('#') && !line.startsWith('#HttpOnly_')))
    .map(line => line.split('\t'))
}

const IMPORT_FILE = [
  '# Netscape HTTP Cookie File',
  '.shop.test\tTRUE\t/\tFALSE\t1900000000\tsid\tsession-value',
  '.shop.test\tTRUE\t/\tTRUE\t0\tcsrf\ttoken',
  'other.test\tFALSE\t/\tFALSE\t1900000000\ttheme\tdark',
  '',
].join('\n')

describe('vfox cookies export', () => {
  it('writes a cookies.txt even when the profile has no cookie store yet', async () => {
    const profile = await createProfile()
    const out = path.join(dataDir, 'out.cookies.txt')

    const result = await runCli(withDir('cookies', 'export', 'Alpha', '--out', out, '--json'))
    expect(result.code).toBe(0)
    const body = parseJson(result.stdout)
    expect(body).toMatchObject({ profileId: profile.id, cookies: 0, hasCookieStore: false })

    const text = await readFile(out, 'utf8')
    expect(text).toContain('# Netscape HTTP Cookie File')
    expect(cookieLines(text)).toEqual([])

    // `--json` keeps stdout parseable, so the warning only appears in human mode.
    const human = await runCli(withDir('cookies', 'export', 'Alpha', '--out', out))
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('Exported 0 cookie(s)')
    expect(human.stderr).toContain('no cookie store yet')
  })

  it('writes every cookie the store holds', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id, [
      { name: 'sid', value: 'abc', host: '.shop.test', expiry: 1900000000 },
      { name: 'csrf', value: 'token', host: '.shop.test', secure: 1, httpOnly: 1 },
      { name: 'boxed', value: 'x', host: '.shop.test' },
    ])

    const out = path.join(dataDir, 'nested', 'out.cookies.txt')
    const result = await runCli(withDir('cookies', 'export', profile.id, '--out', out, '--json'))
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({ cookies: 3, hasCookieStore: true })

    const lines = cookieLines(await readFile(out, 'utf8'))
    expect(lines.map(fields => fields[5]).sort()).toEqual(['boxed', 'csrf', 'sid'])
    expect(lines.find(fields => fields[5] === 'csrf')).toEqual([
      '#HttpOnly_.shop.test',
      'TRUE',
      '/',
      'TRUE',
      '0',
      'csrf',
      'token',
    ])
  })

  it('accepts a profile name and a profile id alike', async () => {
    const profile = await createProfile('Named')
    const byName = await runCli(
      withDir('cookies', 'export', 'Named', '--out', path.join(dataDir, 'a.txt')),
    )
    const byId = await runCli(
      withDir('cookies', 'export', profile.id, '--out', path.join(dataDir, 'b.txt')),
    )
    expect(byName.code).toBe(0)
    expect(byId.code).toBe(0)
    expect(await readFile(path.join(dataDir, 'a.txt'), 'utf8')).toBe(
      await readFile(path.join(dataDir, 'b.txt'), 'utf8'),
    )
  })

  it('requires --out', async () => {
    await createProfile()
    const result = await runCli(withDir('cookies', 'export', 'Alpha'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--out <file> is required')
  })

  it('fails on an unknown profile', async () => {
    const result = await runCli(
      withDir('cookies', 'export', 'ghost', '--out', path.join(dataDir, 'x.txt')),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown profile: ghost')
  })
})

describe('vfox cookies import', () => {
  it('refuses a profile that has never been launched, and says what to do', async () => {
    await createProfile()
    const file = path.join(dataDir, 'in.cookies.txt')
    await writeFile(file, IMPORT_FILE, 'utf8')

    const result = await runCli(withDir('cookies', 'import', 'Alpha', '--in', file))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('launch it once')
  })

  it('merges into an existing jar', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id, [{ name: 'keep', value: 'original', host: '.mine.test' }])
    const file = path.join(dataDir, 'in.cookies.txt')
    await writeFile(file, IMPORT_FILE, 'utf8')

    const result = await runCli(withDir('cookies', 'import', 'Alpha', '--in', file, '--json'))
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({
      profileId: profile.id,
      mode: 'merge',
      parsed: 3,
      written: 3,
      updated: 0,
      removed: 0,
      skipped: [],
    })

    const out = path.join(dataDir, 'out.cookies.txt')
    await runCli(withDir('cookies', 'export', 'Alpha', '--out', out))
    const names = cookieLines(await readFile(out, 'utf8')).map(fields => fields[5])
    expect(names.sort()).toEqual(['csrf', 'keep', 'sid', 'theme'])
  })

  it('updates a cookie it already has instead of duplicating it', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id, [
      { name: 'sid', value: 'stale', host: '.shop.test', expiry: 1 },
    ])
    const file = path.join(dataDir, 'in.cookies.txt')
    await writeFile(file, IMPORT_FILE, 'utf8')

    const result = await runCli(withDir('cookies', 'import', 'Alpha', '--in', file, '--json'))
    expect(parseJson(result.stdout)).toMatchObject({ written: 3, updated: 1 })

    const out = path.join(dataDir, 'out.cookies.txt')
    await runCli(withDir('cookies', 'export', 'Alpha', '--out', out))
    const lines = cookieLines(await readFile(out, 'utf8'))
    expect(lines.filter(fields => fields[5] === 'sid')).toHaveLength(1)
    expect(lines.find(fields => fields[5] === 'sid')[6]).toBe('session-value')
  })

  it('empties the jar first with --replace', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id, [
      { name: 'stale', value: 'x', host: '.old.test' },
      { name: 'also-stale', value: 'y', host: '.old.test' },
    ])
    const file = path.join(dataDir, 'in.cookies.txt')
    await writeFile(file, IMPORT_FILE, 'utf8')

    const result = await runCli(
      withDir('cookies', 'import', 'Alpha', '--in', file, '--replace', '--json'),
    )
    expect(result.code).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({ mode: 'replace', written: 3, removed: 2 })

    const out = path.join(dataDir, 'out.cookies.txt')
    await runCli(withDir('cookies', 'export', 'Alpha', '--out', out))
    const names = cookieLines(await readFile(out, 'utf8')).map(fields => fields[5])
    expect(names.sort()).toEqual(['csrf', 'sid', 'theme'])
  })

  it('reports unusable lines without failing the whole import', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id)
    const file = path.join(dataDir, 'mixed.cookies.txt')
    await writeFile(
      file,
      [IMPORT_FILE, 'broken line with no tabs', '.shop.test\tTRUE\t/\tFALSE\tNaN\tbad\tv', ''].join(
        '\n',
      ),
      'utf8',
    )

    const result = await runCli(withDir('cookies', 'import', 'Alpha', '--in', file, '--json'))
    expect(result.code).toBe(0)
    const body = parseJson(result.stdout)
    expect(body.written).toBe(3)
    expect(body.skipped).toHaveLength(2)
    expect(body.skipped.map(skip => skip.line)).toEqual([6, 7])
  })

  it('fails when not one line could be read', async () => {
    const profile = await createProfile()
    await createCookieStore(profile.id)
    const file = path.join(dataDir, 'junk.cookies.txt')
    await writeFile(file, 'this is not a cookie file at all\n', 'utf8')

    const result = await runCli(withDir('cookies', 'import', 'Alpha', '--in', file))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No usable cookies in that file')
  })

  it('requires --in', async () => {
    await createProfile()
    const result = await runCli(withDir('cookies', 'import', 'Alpha'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--in <file> is required')
  })

  it('fails when the file does not exist', async () => {
    await createProfile()
    const result = await runCli(
      withDir('cookies', 'import', 'Alpha', '--in', path.join(dataDir, 'missing.txt')),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('File not found')
  })
})

describe('vfox cookies (dispatch)', () => {
  it('rejects an unknown action', async () => {
    const result = await runCli(withDir('cookies', 'frobnicate', 'Alpha'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown cookies action')
  })

  it('requires an action', async () => {
    const result = await runCli(withDir('cookies'))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing action')
  })

  it('documents itself in the top-level help', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('vfox cookies export|import')
  })
})

describe('a session moved between two profiles', () => {
  it('ends up in the second profile exactly as it left the first', async () => {
    const source = await createProfile('Source')
    const target = await createProfile('Target')
    await createCookieStore(source.id, [
      { name: 'sid', value: 'session-value', host: '.shop.test', expiry: 1900000000 },
      { name: 'csrf', value: 'token', host: '.shop.test', secure: 1, httpOnly: 1 },
    ])
    await createCookieStore(target.id)

    const file = path.join(dataDir, 'move.cookies.txt')
    expect((await runCli(withDir('cookies', 'export', 'Source', '--out', file))).code).toBe(0)
    expect((await runCli(withDir('cookies', 'import', 'Target', '--in', file))).code).toBe(0)

    const back = path.join(dataDir, 'back.cookies.txt')
    expect((await runCli(withDir('cookies', 'export', 'Target', '--out', back))).code).toBe(0)

    // Byte-identical: the file that moved is the file the second profile now produces.
    expect(await readFile(back, 'utf8')).toBe(await readFile(file, 'utf8'))
  })
})
