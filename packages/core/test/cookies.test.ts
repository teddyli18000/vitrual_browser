/**
 * The SQLite side of cookie import/export, exercised against a real `cookies.sqlite` built from
 * Firefox's own schema.
 *
 * What this does **not** prove: that the engine's file matches this fixture byte-for-byte. The
 * fixture is written from the schema Firefox documents and is the reason every statement here is
 * built from `PRAGMA table_info` rather than a hard-coded column list — the test with a *reduced*
 * schema is what stands in for "a Firefox version we have not seen". A real export from a live
 * profile, and a real import that a browser then uses, can only be proven on a machine that can
 * launch the engine, i.e. in CI.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cookieDbPath, readJar, writeJar } from '../src/cookies.js'
import type { NetscapeCookie } from '../src/netscape.js'
import { formatNetscape, parseNetscape } from '../src/netscape.js'

/** Firefox's `moz_cookies`, as the engine creates it. */
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

/** The subset an older Firefox had, to prove nothing assumes the newer columns exist. */
const OLD_SCHEMA = `
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
  isHttpOnly INTEGER
);`

let dir: string
let dbFile: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-cookies-'))
  dbFile = cookieDbPath(dir)
})

afterEach(async () => {
  // Windows can still hold the file for a moment after a handle is closed.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function createStore(schema = FIREFOX_SCHEMA, file = dbFile): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(schema)
  return db
}

interface SeedRow {
  name: string
  value: string
  host: string
  path?: string
  expiry?: number
  isSecure?: number
  isHttpOnly?: number
  originAttributes?: string
  sameSite?: number
}

/** Inserts rows using only the columns the fixture schema actually has. */
function seed(rows: readonly SeedRow[], file = dbFile): void {
  const db = new DatabaseSync(file)
  try {
    const available = new Set(
      (db.prepare('PRAGMA table_info(moz_cookies)').all() as Array<{ name?: unknown }>).map(row =>
        String(row.name ?? ''),
      ),
    )
    const wanted: Array<[string, (row: SeedRow) => string | number]> = [
      ['name', row => row.name],
      ['value', row => row.value],
      ['host', row => row.host],
      ['path', row => row.path ?? '/'],
      ['expiry', row => row.expiry ?? 0],
      ['isSecure', row => row.isSecure ?? 0],
      ['isHttpOnly', row => row.isHttpOnly ?? 0],
      ['originAttributes', row => row.originAttributes ?? ''],
      ['sameSite', row => row.sameSite ?? 0],
    ]
    const used = wanted.filter(([column]) => available.has(column))
    const insert = db.prepare(
      `INSERT INTO moz_cookies (${used.map(([column]) => column).join(', ')}) ` +
        `VALUES (${used.map(() => '?').join(', ')})`,
    )
    for (const row of rows) insert.run(...used.map(([, value]) => value(row)))
  } finally {
    db.close()
  }
}

function countRows(file = dbFile): number {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM moz_cookies').get() as { n: number | bigint }
    return Number(row.n)
  } finally {
    db.close()
  }
}

const cookie = (overrides: Partial<NetscapeCookie> = {}): NetscapeCookie => ({
  domain: '.example.com',
  path: '/',
  secure: false,
  expiry: 0,
  name: 'sid',
  value: 'abc',
  httpOnly: false,
  ...overrides,
})

describe('readJar', () => {
  it('reports a profile that has never been launched instead of failing', async () => {
    expect(await readJar(dbFile)).toEqual({ cookies: [], skipped: [], hasStore: false })
  })

  it('maps every column the format needs', async () => {
    createStore().close()
    seed([
      {
        name: 'sid',
        value: 'abc',
        host: '.example.com',
        path: '/app',
        expiry: 1735689600,
        isSecure: 1,
        isHttpOnly: 1,
      },
      { name: 'theme', value: 'dark', host: 'example.com' },
    ])

    const { cookies, skipped, hasStore } = await readJar(dbFile)
    expect(hasStore).toBe(true)
    expect(skipped).toEqual([])
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toEqual({
      domain: '.example.com',
      path: '/app',
      secure: true,
      expiry: 1735689600,
      name: 'sid',
      value: 'abc',
      httpOnly: true,
    })
    expect(cookies[1]).toMatchObject({ domain: 'example.com', path: '/', expiry: 0, secure: false })
  })

  it('skips container and partitioned cookies and says why', async () => {
    createStore().close()
    seed([
      { name: 'plain', value: 'v', host: '.example.com' },
      { name: 'boxed', value: 'v', host: '.example.com', originAttributes: '^userContextId=2' },
    ])

    const { cookies, skipped } = await readJar(dbFile)
    expect(cookies.map(entry => entry.name)).toEqual(['plain'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.detail).toBe('boxed@.example.com')
    expect(skipped[0]?.reason).toMatch(/originAttributes/)
  })

  it('works against an older schema without the newer columns', async () => {
    const oldFile = path.join(dir, 'old.sqlite')
    createStore(OLD_SCHEMA, oldFile).close()
    seed([{ name: 'sid', value: 'abc', host: '.example.com', isSecure: 1 }], oldFile)

    const { cookies } = await readJar(oldFile)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ name: 'sid', secure: true, httpOnly: false, expiry: 0 })
  })

  it('returns nothing for a file that is not a cookie store', async () => {
    const empty = path.join(dir, 'empty.sqlite')
    new DatabaseSync(empty).close()
    expect(await readJar(empty)).toEqual({ cookies: [], skipped: [], hasStore: true })
  })
})

describe('writeJar', () => {
  it('refuses to invent a cookie store for a profile that has never been launched', async () => {
    await expect(writeJar(dbFile, [cookie()], 'merge')).rejects.toThrow(/launch it once/)
    await expect(fs.access(dbFile)).rejects.toThrow()
  })

  it('inserts into an empty jar', async () => {
    createStore().close()
    const result = await writeJar(dbFile, [cookie(), cookie({ name: 'other' })], 'merge')
    expect(result).toEqual({ written: 2, updated: 0, removed: 0 })
    expect(countRows()).toBe(2)
  })

  it('upserts on (host, name, path) instead of duplicating', async () => {
    createStore().close()
    await writeJar(dbFile, [cookie({ value: 'first' })], 'merge')
    const second = await writeJar(dbFile, [cookie({ value: 'second' })], 'merge')

    expect(second).toEqual({ written: 1, updated: 1, removed: 0 })
    expect(countRows()).toBe(1)
    const { cookies } = await readJar(dbFile)
    expect(cookies[0]?.value).toBe('second')
  })

  it('leaves cookies the file does not mention alone in merge mode', async () => {
    createStore().close()
    await writeJar(dbFile, [cookie({ name: 'keep', value: 'original' })], 'merge')
    await writeJar(dbFile, [cookie({ name: 'added', value: 'new' })], 'merge')

    const { cookies } = await readJar(dbFile)
    expect(cookies.map(entry => entry.name).sort()).toEqual(['added', 'keep'])
    expect(cookies.find(entry => entry.name === 'keep')?.value).toBe('original')
  })

  it('empties the jar first in replace mode', async () => {
    createStore().close()
    await writeJar(dbFile, [cookie({ name: 'stale' }), cookie({ name: 'also-stale' })], 'merge')
    const result = await writeJar(dbFile, [cookie({ name: 'only' })], 'replace')

    expect(result).toEqual({ written: 1, updated: 0, removed: 2 })
    expect(countRows()).toBe(1)
    const { cookies } = await readJar(dbFile)
    expect(cookies.map(entry => entry.name)).toEqual(['only'])
  })

  it('writes sameSite as unspecified on insert and on update', async () => {
    createStore().close()
    await writeJar(dbFile, [cookie()], 'merge')

    const db = new DatabaseSync(dbFile)
    const setStrict = db.prepare('UPDATE moz_cookies SET sameSite = 2, rawSameSite = 2')
    setStrict.run()
    db.close()

    await writeJar(dbFile, [cookie({ value: 'replaced' })], 'merge')

    const check = new DatabaseSync(dbFile)
    const row = check.prepare('SELECT sameSite, rawSameSite, value FROM moz_cookies').get() as {
      sameSite: number | bigint
      rawSameSite: number | bigint
      value: string
    }
    check.close()
    expect(Number(row.sameSite)).toBe(0)
    expect(Number(row.rawSameSite)).toBe(0)
    expect(row.value).toBe('replaced')
  })

  it('fills the columns an older schema has and nothing more', async () => {
    const oldFile = path.join(dir, 'old.sqlite')
    createStore(OLD_SCHEMA, oldFile).close()
    await writeJar(oldFile, [cookie({ name: 'sid', value: 'abc' })], 'merge')

    const db = new DatabaseSync(oldFile)
    const row = db
      .prepare('SELECT name, value, host, path, isSecure, isHttpOnly FROM moz_cookies')
      .get()
    db.close()
    expect(row).toEqual({
      name: 'sid',
      value: 'abc',
      host: '.example.com',
      path: '/',
      isSecure: 0,
      isHttpOnly: 0,
    })
  })
})

describe('a full move between two profiles', () => {
  it('carries a session from one jar to another through the file format', async () => {
    const source = path.join(dir, 'source.sqlite')
    const target = path.join(dir, 'target.sqlite')
    createStore(FIREFOX_SCHEMA, source).close()
    createStore(FIREFOX_SCHEMA, target).close()

    seed(
      [
        { name: 'sid', value: 'session-value', host: '.shop.test', path: '/', expiry: 1900000000 },
        { name: 'csrf', value: 'token', host: '.shop.test', isHttpOnly: 1, isSecure: 1 },
        { name: 'boxed', value: 'x', host: '.shop.test', originAttributes: '^userContextId=1' },
      ],
      source,
    )

    const exported = await readJar(source)
    expect(exported.cookies).toHaveLength(2)
    expect(exported.skipped).toHaveLength(1)

    const text = formatNetscape(exported.cookies)
    const parsed = parseNetscape(text)
    expect(parsed.skipped).toEqual([])

    const written = await writeJar(target, parsed.cookies, 'merge')
    expect(written).toEqual({ written: 2, updated: 0, removed: 0 })

    const restored = await readJar(target)
    // Everything the format can carry survives the trip; SameSite does not, by design.
    expect(restored.cookies.map(entry => entry.name).sort()).toEqual(['csrf', 'sid'])
    expect(restored.cookies.find(entry => entry.name === 'sid')).toMatchObject({
      domain: '.shop.test',
      value: 'session-value',
      expiry: 1900000000,
    })
    expect(restored.cookies.find(entry => entry.name === 'csrf')).toMatchObject({
      httpOnly: true,
      secure: true,
    })

    // And the file a second export produces is byte-identical to the one that moved.
    expect(formatNetscape(restored.cookies)).toBe(text)
  })
})
