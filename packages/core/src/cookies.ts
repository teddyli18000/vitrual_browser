/**
 * A profile's cookie jar: `<userdata>/cookies.sqlite`, Firefox's own store, read and written
 * directly.
 *
 * **Why disk and not the browser.** The jar of record is that file. Reading it through the engine
 * would mean launching a browser per profile — unacceptable for the "export my fifty profiles"
 * case — and writing it through a live browser would race the in-memory jar that Firefox owns.
 * Both directions therefore require the profile to be stopped, and the caller enforces that. The
 * cost is one extra step for the user (stop the profile first) and one hard rule: a profile that
 * has never been launched has no cookie store, so an import into it is refused with an actionable
 * message instead of inventing a database Firefox would then have to migrate.
 *
 * SQLite comes from Node's built-in `node:sqlite` (unflagged since Node 22.13/23.4; present in
 * Node 24 and in Electron 38's Node 22.22). That keeps the dependency count at zero and adds no
 * native module to the tree. It is imported lazily so the module's ExperimentalWarning only appears
 * when a cookie command is actually used, and a build without it fails with a clear message rather
 * than a stack trace.
 *
 * The `moz_cookies` schema has changed across Firefox releases (`schemeMap` and
 * `isPartitionedAttributeSet` are recent additions), so every statement is built from
 * `PRAGMA table_info` rather than assuming a column set. Nothing here writes DDL: the file is
 * created and migrated by the engine alone.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { CookieImportMode, CookieSkip } from '@vfox/shared'

import type { NetscapeCookie } from './netscape.js'

export const COOKIE_DB_FILE = 'cookies.sqlite'

const COOKIE_TABLE = 'moz_cookies'
/** Firefox stores `creationTime` / `lastAccessed` as microseconds since the epoch. */
const MICROSECONDS_PER_SECOND = 1_000_000

export function cookieDbPath(userDataDir: string): string {
  return path.join(userDataDir, COOKIE_DB_FILE)
}

type SqliteModule = typeof import('node:sqlite')

/**
 * `node:sqlite` is present in Node 22.13+/23.4+/24 and in Electron 38. An older runtime gets an
 * explanation, not `ERR_UNKNOWN_BUILTIN_MODULE`.
 */
async function loadSqlite(): Promise<SqliteModule> {
  try {
    return await import('node:sqlite')
  } catch (error) {
    throw new Error(
      "Reading or writing a profile's cookies needs the built-in node:sqlite module, which this " +
        'runtime does not provide. Node 22.13+ (or 23.4+) and Electron 38+ have it; Node 22.12 and ' +
        'older need --experimental-sqlite.',
      { cause: error },
    )
  }
}

async function openDatabase(file: string): Promise<import('node:sqlite').DatabaseSync> {
  const { DatabaseSync } = await loadSqlite()
  // Opened read-write on purpose, even for a plain export: a profile that was killed rather than
  // stopped leaves a `-wal` file behind, and SQLite can only recover it with write access. The
  // recovery is a correctness step, not a data change.
  return new DatabaseSync(file)
}

/** Column names of `moz_cookies`, or an empty set when the table (or the file) has none. */
function tableColumns(db: import('node:sqlite').DatabaseSync): Set<string> {
  // `COOKIE_TABLE` is a module constant, never user input.
  const rows = db.prepare(`PRAGMA table_info(${COOKIE_TABLE})`).all() as Array<{ name?: unknown }>
  return new Set(rows.map(row => String(row.name ?? '')))
}

function requireColumns(columns: Set<string>): void {
  const missing = ['name', 'value', 'host', 'path'].filter(column => !columns.has(column))
  if (missing.length > 0) {
    throw new Error(
      `The profile's cookie store has no ${missing.join('/')} column — it is not a Firefox ` +
        'cookies.sqlite. Nothing was written.',
    )
  }
}

/** `column` when it exists, otherwise a constant with the same alias, so the SELECT shape is fixed. */
function orConstant(columns: Set<string>, column: string, fallback: string): string {
  return columns.has(column) ? column : `${fallback} AS ${column}`
}

export interface JarReadResult {
  cookies: NetscapeCookie[]
  skipped: CookieSkip[]
  /** `false` when the profile has no `cookies.sqlite` at all, i.e. it has never been launched. */
  hasStore: boolean
}

/**
 * Every cookie in the jar that the Netscape format can represent.
 *
 * A missing `cookies.sqlite` is not an error — a profile that has never been launched simply has an
 * empty jar — and yields an empty list so an export still produces a valid (header-only) file. The
 * caller is told which of the two it was, because "0 cookies" and "no cookie store yet" need
 * different words in front of a user.
 */
export async function readJar(dbFile: string): Promise<JarReadResult> {
  if (!(await fileExists(dbFile))) return { cookies: [], skipped: [], hasStore: false }

  const db = await openDatabase(dbFile)
  try {
    const columns = tableColumns(db)
    if (columns.size === 0) return { cookies: [], skipped: [], hasStore: true }
    requireColumns(columns)

    const rows = db
      .prepare(
        `SELECT name, value, host, path, ` +
          `${orConstant(columns, 'expiry', '0')}, ` +
          `${orConstant(columns, 'isSecure', '0')}, ` +
          `${orConstant(columns, 'isHttpOnly', '0')}, ` +
          `${orConstant(columns, 'originAttributes', "''")} ` +
          `FROM ${COOKIE_TABLE}`,
      )
      .all() as Array<Record<string, unknown>>

    const cookies: NetscapeCookie[] = []
    const skipped: CookieSkip[] = []

    for (const row of rows) {
      const name = String(row.name ?? '')
      const host = String(row.host ?? '')
      const originAttributes = String(row.originAttributes ?? '')
      if (name === '' || host === '') continue

      if (originAttributes !== '') {
        // Importing one of these as a plain cookie would silently widen its scope, which is worse
        // than leaving it behind. Reported so the user knows it is not in the file.
        skipped.push({
          line: null,
          detail: `${name}@${host}`,
          reason:
            'container or partitioned cookie (originAttributes is set) — the Netscape format has ' +
            'no way to express it',
        })
        continue
      }

      const cookiePath = String(row.path ?? '')
      cookies.push({
        domain: host,
        path: cookiePath === '' ? '/' : cookiePath,
        secure: toBoolean(row.isSecure),
        expiry: toNumber(row.expiry),
        name,
        value: String(row.value ?? ''),
        httpOnly: toBoolean(row.isHttpOnly),
      })
    }

    return { cookies, skipped, hasStore: true }
  } finally {
    db.close()
  }
}

export interface JarWriteResult {
  written: number
  updated: number
  removed: number
}

/**
 * Write cookies into the jar.
 *
 * `merge` upserts by `(name, host, path, originAttributes)` — the key Firefox itself enforces —
 * and leaves every other cookie alone. `replace` empties the table first, so the profile ends up
 * with exactly the file.
 *
 * `sameSite`/`rawSameSite` are set to `0` ("unspecified", which Firefox treats as Lax) on insert
 * *and* on update. Carrying over whatever the profile happened to have would make the same file
 * behave differently depending on what was already there, which is precisely the unpredictability
 * this feature must not have.
 */
export async function writeJar(
  dbFile: string,
  cookies: readonly NetscapeCookie[],
  mode: CookieImportMode,
): Promise<JarWriteResult> {
  if (!(await fileExists(dbFile))) {
    throw new Error(
      'This profile has no cookie store yet — launch it once so the engine creates its ' +
        'cookies.sqlite, then import again. VFox will not fabricate a Firefox database.',
    )
  }

  const db = await openDatabase(dbFile)
  try {
    const columns = tableColumns(db)
    requireColumns(columns)

    const hasOriginAttributes = columns.has('originAttributes')
    const findExisting = db.prepare(
      `SELECT id FROM ${COOKIE_TABLE} WHERE name = ? AND host = ? AND path = ?` +
        (hasOriginAttributes ? ` AND originAttributes = ''` : ''),
    )

    const insertColumns = INSERTABLE.filter(([column]) => columns.has(column))
    const insert = db.prepare(
      `INSERT INTO ${COOKIE_TABLE} (${insertColumns.map(([column]) => column).join(', ')}) ` +
        `VALUES (${insertColumns.map(() => '?').join(', ')})`,
    )

    const updateColumns = UPDATABLE.filter(([column]) => columns.has(column))
    const update = db.prepare(
      `UPDATE ${COOKIE_TABLE} SET ${updateColumns.map(([column]) => `${column} = ?`).join(', ')} ` +
        'WHERE id = ?',
    )

    const now = Date.now() * MICROSECONDS_PER_SECOND
    const result: JarWriteResult = { written: 0, updated: 0, removed: 0 }

    // One transaction: an import either lands whole or not at all, so a failure halfway through a
    // 300-cookie file cannot leave the profile with a half-replaced session.
    db.exec('BEGIN IMMEDIATE')
    try {
      if (mode === 'replace') {
        result.removed = toNumber(db.prepare(`DELETE FROM ${COOKIE_TABLE}`).run().changes)
      }

      for (const cookie of cookies) {
        const existing = findExisting.all(cookie.name, cookie.domain, cookie.path) as Array<{
          id?: unknown
        }>
        const id = existing[0]?.id
        if (id === undefined) {
          insert.run(...insertColumns.map(([, value]) => value(cookie, now)))
        } else {
          update.run(...updateColumns.map(([, value]) => value(cookie, now)), toSqlId(id))
          result.updated += 1
        }
        result.written += 1
      }

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    return result
  } finally {
    db.close()
  }
}

type ValueFactory = (cookie: NetscapeCookie, now: number) => string | number

/**
 * Columns VFox knows how to fill, in insertion order. Anything the installed Firefox does not have
 * is filtered out, so this works against both an older and a newer `moz_cookies`.
 */
const INSERTABLE: ReadonlyArray<readonly [string, ValueFactory]> = [
  ['originAttributes', () => ''],
  ['name', cookie => cookie.name],
  ['value', cookie => cookie.value],
  ['host', cookie => cookie.domain],
  ['path', cookie => cookie.path],
  ['expiry', cookie => cookie.expiry],
  ['lastAccessed', (_cookie, now) => now],
  ['creationTime', (_cookie, now) => now],
  ['isSecure', cookie => (cookie.secure ? 1 : 0)],
  ['isHttpOnly', cookie => (cookie.httpOnly ? 1 : 0)],
  ['inBrowserElement', () => 0],
  ['sameSite', () => 0],
  ['rawSameSite', () => 0],
  ['schemeMap', () => 0],
  ['isPartitionedAttributeSet', () => 0],
]

/** On update, `creationTime` is deliberately kept: the cookie is the same cookie, re-valued. */
const UPDATABLE: ReadonlyArray<readonly [string, ValueFactory]> = [
  ['value', cookie => cookie.value],
  ['expiry', cookie => cookie.expiry],
  ['lastAccessed', (_cookie, now) => now],
  ['isSecure', cookie => (cookie.secure ? 1 : 0)],
  ['isHttpOnly', cookie => (cookie.httpOnly ? 1 : 0)],
  ['sameSite', () => 0],
  ['rawSameSite', () => 0],
]

function toBoolean(value: unknown): boolean {
  return toNumber(value) !== 0
}

/** `moz_cookies.id` is an INTEGER PRIMARY KEY, so SQLite hands it back as a number or a bigint. */
function toSqlId(value: unknown): number | bigint {
  if (typeof value === 'bigint') return value
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`moz_cookies.id is not numeric: ${String(value)}`)
  }
  return parsed
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
