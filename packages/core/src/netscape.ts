/**
 * The Netscape `cookies.txt` format — the interchange format curl, wget, yt-dlp and the other
 * anti-detect browsers read and write.
 *
 * It was chosen over a bespoke JSON form on purpose: the whole point of the feature is moving a
 * logged-in session between machines and between tools, and this is the only cookie format that
 * everything already speaks. Adding a second, richer format would double the surface for a fidelity
 * gain that matters for exactly two fields — see the losses documented on {@link formatNetscape}.
 *
 * This module is pure text in / text out. It never touches a browser, a profile or SQLite, which is
 * what makes the parsing rules testable without a launch.
 *
 * Layout (one TAB-separated line per cookie):
 *
 *   domain  includeSubdomains  path  secure  expiry  name  value
 *
 * A leading `.` on the domain means "include subdomains"; the boolean field restates it. curl also
 * writes the `#HttpOnly_` prefix on the domain to mark an HttpOnly cookie, which is the only way
 * the format can carry that flag, and it is honoured here in both directions.
 */

import type { CookieSkip } from '@vfox/shared'

/** curl's convention for carrying `HttpOnly` through a format that has no field for it. */
export const HTTP_ONLY_PREFIX = '#HttpOnly_'

export interface NetscapeCookie {
  /** Domain as written: a leading dot means the cookie applies to subdomains. */
  domain: string
  path: string
  secure: boolean
  /** Unix seconds. `0` means a session cookie. */
  expiry: number
  name: string
  value: string
  httpOnly: boolean
}

export interface NetscapeParseResult {
  cookies: NetscapeCookie[]
  skipped: CookieSkip[]
}

const HEADER = [
  '# Netscape HTTP Cookie File',
  '# https://curl.se/docs/http-cookies.html',
  '# Exported by VFox.',
  '#',
  '# SameSite has no field in this format, so an imported cookie lands as "unspecified",',
  '# which Firefox treats as Lax. Container and partitioned cookies (a non-empty',
  '# originAttributes) cannot be represented at all and are reported as skipped.',
].join('\n')

/** Values may not contain the field or line separators; strip them rather than emit a broken file. */
function clean(value: string): string {
  return value.replace(/[\t\r\n]/g, '')
}

/**
 * Parse a cookies.txt file.
 *
 * Deliberately liberal in what it accepts and strict about what it reports: a line that cannot be
 * understood becomes a {@link CookieSkip} with its line number and the reason, never a silently
 * dropped cookie.
 */
export function parseNetscape(text: string): NetscapeParseResult {
  const cookies: NetscapeCookie[] = []
  const skipped: CookieSkip[] = []
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const lineNumber = index + 1
    if (raw.trim() === '') continue

    const httpOnly = raw.startsWith(HTTP_ONLY_PREFIX)
    // Every other `#` line is a comment; `#HttpOnly_` is a cookie line wearing a prefix.
    if (raw.startsWith('#') && !httpOnly) continue

    const fields = raw.split('\t')
    if (fields.length !== 7) {
      skipped.push({
        line: lineNumber,
        detail: raw.slice(0, 120),
        reason: `expected 7 tab-separated fields, found ${fields.length}`,
      })
      continue
    }

    const [rawDomain = '', rawSubdomains = '', rawPath = '', rawSecure = '', rawExpiry = ''] =
      fields
    const name = fields[5] ?? ''
    const value = fields[6] ?? ''

    const domainField = httpOnly ? rawDomain.slice(HTTP_ONLY_PREFIX.length) : rawDomain
    const domain = domainField.trim()
    if (domain === '' || /\s/.test(domain)) {
      skipped.push({
        line: lineNumber,
        detail: raw.slice(0, 120),
        reason: 'empty or malformed domain',
      })
      continue
    }
    if (name === '') {
      skipped.push({ line: lineNumber, detail: raw.slice(0, 120), reason: 'empty cookie name' })
      continue
    }

    const expiry = Number.parseInt(rawExpiry.trim(), 10)
    if (!Number.isFinite(expiry)) {
      skipped.push({
        line: lineNumber,
        detail: raw.slice(0, 120),
        reason: `expiry is not a number: "${rawExpiry.trim()}"`,
      })
      continue
    }

    // The dot is authoritative: Firefox encodes "applies to subdomains" in the stored host, so a
    // file that sets the boolean without the dot is normalised to the form the store understands.
    const hasDot = domain.startsWith('.')
    const includeSubdomains = hasDot || parseFlag(rawSubdomains)
    const normalised = includeSubdomains && !hasDot ? `.${domain}` : domain
    const cookiePath = rawPath.trim() === '' ? '/' : rawPath.trim()

    cookies.push({
      domain: normalised,
      path: cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`,
      secure: parseFlag(rawSecure),
      // Anything at or below zero is a session cookie; Firefox has used both 0 and negative values.
      expiry: expiry > 0 ? expiry : 0,
      name,
      value,
      httpOnly,
    })
  }

  return { cookies, skipped }
}

/**
 * Render cookies as cookies.txt.
 *
 * **Lossy, by design and in exactly two ways**, both stated in the file's own header so the user
 * finds out from the artifact rather than from a bug report:
 *
 * 1. `SameSite` has no field. An import therefore lands as "unspecified", which Firefox treats as
 *    Lax. A cookie that was `SameSite=None` and is used in a cross-site/embedded context will stop
 *    being sent there; ordinary top-level navigation is unaffected.
 * 2. Cookies with a non-empty `originAttributes` — container and partitioned (CHIPS) cookies —
 *    cannot be represented. The caller skips those and reports them rather than downgrading them
 *    into an unpartitioned cookie with a wider scope than they had.
 *
 * Output is sorted so two exports of the same jar are byte-identical.
 */
export function formatNetscape(cookies: readonly NetscapeCookie[]): string {
  const lines = [...cookies]
    .sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.path.localeCompare(b.path) ||
        a.name.localeCompare(b.name),
    )
    .map(cookie => {
      const includeSubdomains = cookie.domain.startsWith('.')
      const prefix = cookie.httpOnly ? HTTP_ONLY_PREFIX : ''
      const expiry = cookie.expiry > 0 ? Math.floor(cookie.expiry) : 0
      return [
        `${prefix}${clean(cookie.domain)}`,
        includeSubdomains ? 'TRUE' : 'FALSE',
        clean(cookie.path),
        cookie.secure ? 'TRUE' : 'FALSE',
        String(expiry),
        clean(cookie.name),
        clean(cookie.value),
      ].join('\t')
    })

  return `${[HEADER, ...lines].join('\n')}\n`
}

function parseFlag(value: string): boolean {
  const normalised = value.trim().toUpperCase()
  return normalised === 'TRUE' || normalised === '1'
}
