/**
 * Reading the Netscape `cookies.txt` body the export route returns.
 *
 * The route hands back the file itself, not a summary, so the only way to tell the user what they
 * just saved is to count it — and "0 cookies" has to be distinguishable from "a few", because a
 * profile that has never been launched exports a valid, header-only file and the user must not
 * think their session is in it.
 */

/**
 * `#HttpOnly_` is curl's convention for carrying the HttpOnly flag through a format that has no
 * field for it, so those lines are cookies even though they start with `#`; every other `#` line
 * is the comment header. Mirrors `packages/core/src/netscape.ts`.
 */
const HTTP_ONLY_PREFIX = '#HttpOnly_'

export function countCookies(text: string): number {
  let count = 0
  for (const line of text.split('\n')) {
    if (line.startsWith(HTTP_ONLY_PREFIX) || (line.trim().length > 0 && !line.startsWith('#'))) {
      count += 1
    }
  }
  return count
}
