/**
 * Durability and isolation of a profile's browser state — the property the product exists for.
 *
 * The gap this closes: the packaged suite runs eight phases and not one of them restarts a profile. The
 * mechanism is `_userDataDir` in `packages/core/src/launcher.ts` — what makes a profile a real directory
 * instead of a throwaway temp one — and nothing would fail if it were dropped. Every profile would still
 * launch, render and report a distinct fingerprint; a user would find out weeks later as "I have to log in
 * again every time", and it would look like the site's fault.
 *
 * THE ROUTES ARE SPLIT, and that is structural rather than cosmetic. The setter lives at `/set`; every
 * other path serves a page that only reports. With one page doing both — the first version of this module
 * — every verification navigation re-seeded the state it was about to assert, so:
 *   · the post-relaunch assertions could not fail, because the probe's own script satisfied them;
 *   · the isolation check could never pass, because profile B's page set B's own cookie and the failure
 *     blamed a shared directory for correct behaviour;
 *   · break mode could not break what it names, because the fresh directory was re-seeded before the read.
 * With the split, all three become real assertions.
 *
 * The phase: `/set` writes an expiring cookie and a localStorage entry from the page itself; profile A
 * loads it and the row is polled for in the profile's `cookies.sqlite`; A is stopped through the app's own
 * route with the process-tree check; A relaunches and loads the read-only `/`, where the cookie (value and
 * expiry) and the localStorage entry must still be there; profile B loads the same read-only page and must
 * see neither.
 *
 * FLUSH AMBIGUITY, designed against rather than discovered in a red run: the stop is a forced kill and
 * Firefox batches cookie writes, so a bare failure would be ambiguous between "the profile is not durable"
 * and "the engine was killed before it flushed". The poll makes the two distinguishable and the failure
 * message says which one it cannot rule out.
 *
 * Plain HTTP on 127.0.0.1, never a `data:` URL (opaque origin, cookies cannot be set at all). If the engine
 * interferes with a loopback origin the phase reports UNREAD — returned to the caller so it reaches the
 * summary — rather than weakening the assertion.
 *
 * It does NOT prove that a real third-party site's login survives, and says so: credentials must never be
 * in CI. It proves the mechanism.
 *
 * Red run: `VFOX_E2E_BREAK=durability-userdata` deletes the profile's `userdata` between the stop and the
 * relaunch, and must FAIL naming what was lost.
 */

import { existsSync, rmSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

const COOKIE = 'vfox_durable'
const STORAGE_KEY = 'vfox_durable'
/** Written through `context.addCookies`, so the two persistence paths can be told apart. */
const API_COOKIE = 'vfox_durable_api'
/** A day out, so the value that comes back had to be written to the profile's cookies.sqlite. */
const COOKIE_EXPIRY_SECONDS = 86_400

/** Served at `/set`: writes the state, from the page itself. */
function setterPage() {
  const expires = new Date(Date.now() + COOKIE_EXPIRY_SECONDS * 1000).toUTCString()
  return `<!doctype html>
<meta charset="utf-8">
<title>vfox durability: set</title>
<script>
  document.cookie = '${COOKIE}=durable; expires=${expires}; path=/'
  localStorage.setItem('${STORAGE_KEY}', 'durable')
  document.title = 'vfox durability: set'
</script>
<body>durability setter</body>
`
}

/**
 * Served everywhere else: reads only. It must never set anything, or the assertions downstream would be
 * satisfied by this page rather than by what the profile kept.
 */
const READER_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>vfox durability: read</title>
<body>durability reader</body>
`

/** Runs in the page. Reads; never writes. */
const READ_DOCUMENT_STATE = () => ({
  cookie: document.cookie,
  storage: localStorage.getItem('vfox_durable'),
})

async function startOrigin() {
  const server = createServer((request, response) => {
    const route = (request.url ?? '/').split('?')[0]
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(route === '/set' ? setterPage() : READER_PAGE)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  return { server, setter: `${base}/set`, reader: `${base}/` }
}

/**
 * What the profile's own store holds for the reader origin, as the page sees it and as the jar does.
 *
 * Used by the ISOLATION check, which asks whether profile B can see profile A's state: `cookie` is the
 * Playwright cookie entry (truthy when the origin has one) and `document.storage` is the localStorage
 * value. The post-relaunch check does NOT use this - it reads the page directly, because it compares
 * against the strings the seeding step produced, and this shape is not those strings. That mismatch is
 * what made the phase throw instead of reporting a verdict; the two readers are deliberately separate
 * now, and each says which shape it returns.
 */
async function readState(page, reader) {
  await page.goto(reader, { waitUntil: 'domcontentloaded' })
  const document = await page.evaluate(READ_DOCUMENT_STATE)
  const jar = await page.context().cookies(reader)
  return { document, cookie: jar.find(entry => entry.name === COOKIE) }
}

/**
 * Is the cookie row already in the profile's `cookies.sqlite`?
 *
 * `true` / `false` / `'unknown: …'`. The third state matters: a locked or unreadable database must not be
 * reported as "not durable" — they are different defects and only one of them is ours.
 */
async function cookieRowOnDisk(userdata, timeoutMs = 5000) {
  const file = path.join(userdata, 'cookies.sqlite')
  const until = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < until) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(file, { readOnly: true })
      try {
        const row = database
          .prepare('SELECT COUNT(*) AS n FROM moz_cookies WHERE name = ?')
          .get(COOKIE)
        if (row && Number(row.n) > 0) {
          return true
        }
      } finally {
        database.close()
      }
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return lastError ? `unknown: ${lastError.message}` : false
}

/**
 * The row's own columns, not just whether it exists.
 *
 * Where this comes from: the row is PRESENT before the stop (the phase's own check, with its five-second
 * budget) and GONE after it - measured by enumerating the databases at both points. So the stop is what
 * removes it, and Firefox deletes SESSION cookies on a clean shutdown. If the browser stored this cookie
 * with `expiry = 0` despite the `max-age` and the `expires` we set, that single fact would explain the
 * whole contradiction: CI loses it, and the owner's machine keeps 11 persistent cookies, because theirs
 * are persistent and ours would not be.
 *
 * This reads the columns that decide it. Called BEFORE the stop, while the row still exists.
 */
async function cookieRowDetail(userdata) {
  const file = path.join(userdata, 'cookies.sqlite')
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(file, { readOnly: true })
    try {
      const row = database
        .prepare(
          'SELECT name, host, path, expiry, isSecure, isHttpOnly, originAttributes FROM moz_cookies WHERE name = ?',
        )
        .get(COOKIE)
      // How many cookies the database holds IN TOTAL, not just ours. If the whole jar goes to zero
      // across the stop, the engine rewrote the database from an in-memory jar that never held our
      // cookie - a different defect, and not about our cookie at all. If the count is unchanged and only
      // ours is missing, the row itself is what was removed, which points at expiry and host handling.
      const total = database.prepare('SELECT COUNT(*) AS n FROM moz_cookies').get()
      const totalRows = total ? Number(total.n) : null
      if (!row) return JSON.stringify({ totalRows, row: 'absent' })
      const expiry = Number(row.expiry)
      return JSON.stringify({
        totalRows,
        host: row.host,
        path: row.path,
        expiry,
        expiryLooksLike: expiry > 1e12 ? 'milliseconds' : 'seconds',
        // The two answers this exists for.
        isSessionCookie: expiry === 0,
        expiresInSeconds: expiry > 0 ? Math.round((expiry - Date.now()) / 1000) : null,
      })
    } finally {
      database.close()
    }
  } catch (error) {
    return `unreadable: ${error.message}`
  }
}

/**
 * A stamp of the profile directory, so a relaunch can be shown to have USED it or not.
 *
 * The gap this closes: the lock check proves nothing holds `cookies.sqlite`, and the endpoints differ,
 * so the relaunch is a new engine - but nothing so far proves the new engine opened THIS directory.
 * Firefox touches `prefs.js`, `times.json` and its own `parent.lock` whenever it starts against a
 * profile, so a stamp taken before and after the relaunch answers the only question left: did the
 * second engine use this directory, or a different one?
 */
async function profileDirStamp(userdata) {
  const files = ['cookies.sqlite', 'prefs.js', 'times.json', 'parent.lock', 'compatibility.ini']
  const stamp = {}
  for (const name of files) {
    try {
      const info = await stat(path.join(userdata, name))
      stamp[name] = Math.round(info.mtimeMs)
    } catch {
      stamp[name] = null
    }
  }
  return stamp
}

/**
 * The three files SQLite keeps for a WAL database, with their sizes.
 *
 * A row that lives only in the -wal before the stop, and is gone after a clean close, points at the
 * checkpoint rather than at the engine's cookie logic - and SQLite only removes a -wal after a successful
 * checkpoint, so an empty -wal beside a missing row would itself be the finding. Sizes alone cannot say
 * which file held the row, but they can say whether there was anything in the -wal at all.
 */
async function cookieFileSizes(userdata) {
  const sizes = {}
  for (const name of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) {
    try {
      const info = await stat(path.join(userdata, name))
      sizes[name] = info.size
    } catch {
      sizes[name] = null
    }
  }
  return sizes
}

/**
 * Every cookie database under the profile, with whether our row is in it.
 *
 * The root `cookies.sqlite` is where Firefox keeps them - verified on a real profile on the owner's
 * machine - and the phase polls exactly that file. But two cookies are now gone across a relaunch while
 * the engine demonstrably opens this profile, and on the owner's machine cookies DO persist, so the
 * remaining question is whether we are looking at the database the engine uses. A second file under a
 * subdirectory would answer it outright.
 */
async function cookieDatabases(userdata) {
  const found = []
  const walk = async dir => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name === 'cookies.sqlite') {
        // The same budget as the phase's own check. A shorter one reports GONE for a row that is
        // merely slow to appear, because this function polls - which is how a measurement artefact
        // almost became a finding.
        const row = await cookieRowOnDisk(dir, 5000)
        found.push({ path: full, row: row === true ? 'PRESENT' : row === false ? 'GONE' : row })
      }
    }
  }
  await walk(userdata)
  return found
}

/**
 * Can this process open the profile's `cookies.sqlite` for writing?
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT - the distinction was measured, not assumed. It returns
 * `'free'` when the open succeeds, `'locked: <code>'` when the file is held EXCLUSIVELY, and
 * `'absent'` when there is no database to open.
 *
 * It does NOT prove that no engine survived the stop. SQLite opens its databases with
 * FILE_SHARE_READ | FILE_SHARE_WRITE, so a live engine holding this file still lets a second open
 * succeed: the old version of this helper returned 'free' for a running browser and printed
 * "no surviving engine holds the directory" about it. That is the shape of check this repository keeps
 * shipping - one that cannot fail in the case it exists for - and it was the only check in the suite
 * whose purpose was to catch a survived process tree.
 *
 * The signal that DOES discriminate is the wsEndpoint comparison in the phase: two different endpoints
 * mean a genuinely new engine instance. This helper is kept only for the exclusive-lock case, which is
 * real but rare, and for reporting a missing database as what it is rather than as an accusation.
 */
async function cookiesDbIsFree(userdata) {
  const file = path.join(userdata, 'cookies.sqlite')
  if (!existsSync(file)) return 'absent'
  try {
    const handle = await open(file, 'r+')
    await handle.close()
    return 'free'
  } catch (error) {
    const code = error?.code ?? 'unknown'
    return `locked: ${code}`
  }
}

/**
 * Run the phase against the runner's own module-scope helpers: `api`, `profiles`, `dataDir`,
 * `connect`, `user32` and the `pass`/`fail`/`note` reporters.
 *
 * Returns `{ unread, checks }` so a phase that proved nothing is visible in the summary rather than only
 * inside the log — `note` alone cannot be told apart from ordinary information.
 */
export async function runDurabilityPhase({
  api,
  profiles,
  dataDir,
  connect,
  user32,
  pass,
  fail,
  note,
}) {
  const breakMode = process.env.VFOX_E2E_BREAK ?? ''
  const [profileA, profileB] = profiles
  const unread = []
  const checks = []

  note(
    'NOT PROVEN by this phase: that a real third-party site login survives a restart. Credentials must ' +
      'never be in CI. It proves the mechanism — the browser writes its state into the profile directory ' +
      'and reads it back on the next launch.',
  )

  const userdataDir = id => path.join(dataDir, 'profiles', id, 'userdata')
  // The API client returns `{ status, body }`, so the runtime lives at `body.data`. Reading the wrong
  // level is what made the first real run report "no wsEndpoint" for a 200 response that contained one —
  // the launch path was fine and this helper was not. The shallower shapes stay as fallbacks so a client
  // that unwraps the envelope does not break it again.
  const endpointOf = response =>
    response?.body?.data?.wsEndpoint ?? response?.data?.wsEndpoint ?? response?.wsEndpoint

  /** Best-effort: the GitHub runner has no CIM, so "could not enumerate" is a note, never a pass. */
  const checkNoEngineProcesses = async label => {
    if (!user32?.listEngineProcesses) {
      note(`${label}: process enumeration is unavailable, so the tree check is best-effort here`)
      return
    }
    const processes = await user32.listEngineProcesses()
    if (processes === null) {
      note(`${label}: could not enumerate engine processes (no CIM on this runner) — best-effort`)
      return
    }
    if (processes.length > 0) {
      fail(`${label}: ${processes.length} engine process(es) still alive after the stop`)
    }
  }

  const { server, setter, reader } = await startOrigin()
  try {
    if (!profileA || !profileB) {
      fail('this phase needs two profiles; phase 3 created fewer')
      return { unread, checks }
    }

    // Phase 6 has already launched and driven every profile to a page, so stop A first. The process-tree
    // check below must observe a stop this phase caused, or it is testing phase 6's cleanup instead.
    await api(`/api/v1/profiles/${profileA.id}/stop`, { method: 'POST', body: '{}' })

    const launched = await api(`/api/v1/profiles/${profileA.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const wsEndpoint = endpointOf(launched)
    if (!wsEndpoint) {
      fail(
        `profile ${profileA.name}: the launch returned no wsEndpoint, so its page state cannot be read ` +
          `— the API answered ${JSON.stringify(launched).slice(0, 300)}`,
      )
      return { unread, checks }
    }

    let browser = await connect(wsEndpoint)
    let seeded
    try {
      const page = await browser.newPage()
      // The SETTER route, once. Every later navigation uses the reader.
      await page.goto(setter, { waitUntil: 'domcontentloaded' })
      seeded = await page.evaluate(READ_DOCUMENT_STATE)

      // A SECOND cookie through the browser's own API, for the same origin and the same expiry.
      // It exists to separate two very different failures that currently look identical: if BOTH
      // cookies are gone after the relaunch, the profile's cookie store is not being persisted at
      // all. If only the PAGE-set one is gone, the store works and something about setting a cookie
      // from a page on a plain-HTTP loopback origin is what does not survive - a property of the
      // engine or of the origin, not of the product's promise that a profile keeps its state.
      await page.context().addCookies([
        {
          name: API_COOKIE,
          value: 'durable-api',
          url: reader,
          expires: Math.floor(Date.now() / 1000) + COOKIE_EXPIRY_SECONDS,
        },
      ])
    } finally {
      await browser.close()
    }
    if (!seeded.cookie.includes(COOKIE) || seeded.storage !== 'durable') {
      unread.push(
        `the probe page could not set its state on a plain-HTTP loopback origin — ` +
          `document.cookie=${JSON.stringify(seeded.cookie)} storage=${JSON.stringify(seeded.storage)}`,
      )
      note(`UNREAD: ${unread.at(-1)}`)
      return { unread, checks }
    }
    checks.push('state set')
    pass(
      `profile ${profileA.name}: cookie ${COOKIE} and localStorage set (expiry in ${COOKIE_EXPIRY_SECONDS}s)`,
    )

    // The flush check: makes "not durable" distinguishable from "killed before flushing".
    const onDisk = await cookieRowOnDisk(userdataDir(profileA.id))
    if (onDisk === true) {
      checks.push('cookie row on disk before the stop')
      // While the row is known to be there: is it a SESSION cookie? Firefox deletes those on a clean
      // shutdown, which is exactly when this row disappears - so if the browser stored ours as
      // session-only, everything below would be blaming the product for a cookie it was always going
      // to delete. This asserts the INPUT before it judges the outcome, which is the difference between
      // a phase that reports a real defect and one that manufactures a false one.
      const rowDetail = await cookieRowDetail(userdataDir(profileA.id))
      note(`cookie row columns before the stop: ${rowDetail}`)
      if (rowDetail !== 'no row' && !String(rowDetail).startsWith('unreadable')) {
        const detail = JSON.parse(rowDetail)
        if (detail.isSessionCookie) {
          fail(
            `the browser stored ${COOKIE} as a SESSION cookie (expiry 0) although the phase set a ` +
              `${COOKIE_EXPIRY_SECONDS}s max-age on the page and an expires on context.addCookies. ` +
              'Firefox deletes session cookies at shutdown, so this one could never survive the stop - ' +
              'and the verdict below would be about the test, not the product. Either the browser is ' +
              'dropping our expiry or this phase sets the cookie wrongly; until that is settled, nothing ' +
              'here says a profile loses its state.',
          )
          return { unread, checks }
        }
        if (
          detail.expiresInSeconds !== null &&
          detail.expiresInSeconds < COOKIE_EXPIRY_SECONDS / 2
        ) {
          note(
            `the stored expiry is only ${detail.expiresInSeconds}s away, not the ${COOKIE_EXPIRY_SECONDS}s ` +
              'the phase asked for - worth knowing before reading anything into a later disappearance.',
          )
        }
      }
      pass(`profile ${profileA.name}: the cookie row is already in cookies.sqlite before the stop`)
    } else if (onDisk === false) {
      note(
        'the cookie row was NOT observed in cookies.sqlite before the stop, so a later failure cannot ' +
          'distinguish a profile that is not durable from an engine killed before it flushed',
      )
    } else {
      note(
        `could not read the profile's cookies.sqlite (${onDisk}) — the flush question is undecided`,
      )
    }

    await api(`/api/v1/profiles/${profileA.id}/stop`, { method: 'POST', body: '{}' })
    await checkNoEngineProcesses(`after stopping ${profileA.name}`)

    // BEFORE the checks that can fail: this line is what tells us whether the engine exited on its
    // own or was killed at the deadline, and it is worth nothing if a later assertion aborts first.
    await printLauncherStopLog(dataDir)

    // STOP-LIVENESS, the check that does not need CIM. A live engine holds its profile's
    // databases open; if cookies.sqlite is still locked after the stop, the process tree was
    // NOT killed, and the relaunch below would race the survivor for the same directory.
    // This is the failure that looks like "state was lost" while the state is fine on disk.
    const lockState = await cookiesDbIsFree(userdataDir(profileA.id))
    if (lockState.startsWith('locked: EBUSY') || lockState.startsWith('locked: EPERM')) {
      fail(
        `after stopping ${profileA.name}: the profile's cookies.sqlite is held by an EXCLUSIVE ` +
          `lock (${lockState}). SQLite shares the file, so this is not the ordinary case of a live ` +
          'engine - something holds it against readers too, and the relaunch below would race it.',
      )
      return { unread, checks }
    }
    if (lockState === 'free') {
      pass(`profile ${profileA.name}: cookies.sqlite is not exclusively locked after the stop`)
    } else {
      // NOT a failure, and that is the point. The probe only knows the open did not succeed; a live
      // engine would not make it fail anyway, because SQLite shares the file. A hard failure here is
      // not a measurement - and it was standing in front of the measurement this phase exists for,
      // because the phase stopped at it and never reached the relaunch or the launcher log.
      note(
        `after stopping ${profileA.name}: cookies.sqlite is ${lockState}. That is NOT a finding about ` +
          'a process - the probe only knows the open did not succeed, and a live engine would not make ' +
          'it fail anyway, because SQLite shares the file. The wsEndpoint comparison below is what ' +
          'discriminates a survived engine from a new one, and this check must not stand in front of it.',
      )
    }
    checks.push('cookies.sqlite not exclusively locked after the stop')

    if (breakMode === 'durability-userdata') {
      const target = userdataDir(profileA.id)
      rmSync(target, { recursive: true, force: true })
      note(
        `VFOX_E2E_BREAK=durability-userdata: deleted ${target} between the stop and the relaunch`,
      )
    }

    const dbFilesBefore = await cookieFileSizes(userdataDir(profileA.id))
    note(`cookie files before the relaunch: ${JSON.stringify(dbFilesBefore)}`)

    const dbsBefore = await cookieDatabases(userdataDir(profileA.id))
    note(`cookie databases before the relaunch: ${JSON.stringify(dbsBefore)}`)

    // The comparison that has been missing: the row was found before the stop with a five-second
    // budget, and nothing has ever asked whether it is still there immediately after - only whether the
    // database is writable. Same budget, same function, so the two answers mean something together.
    const rowAfterStop = await cookieRowOnDisk(userdataDir(profileA.id), 5000)
    note(
      `cookie row in cookies.sqlite after the stop: ${
        rowAfterStop === true ? 'PRESENT' : rowAfterStop === false ? 'GONE' : rowAfterStop
      }`,
    )
    checks.push(
      rowAfterStop === true
        ? 'the row is still on disk after the stop - the store keeps it, the relaunch loses it'
        : 'the row is gone from disk after the stop - something removed it on the way out',
    )

    const dbFilesAfter = await cookieFileSizes(userdataDir(profileA.id))
    note(`cookie files after the stop: ${JSON.stringify(dbFilesAfter)}`)
    note(
      'read the two file listings together: a -wal that had content before the stop and none after it ' +
        'points at the checkpoint, and a row count that fell to zero means the engine rewrote the ' +
        'database from a jar that never held our cookie rather than deleting one row.',
    )

    // THE NUMBER THE FILE LISTINGS CANNOT GIVE, and the last one the mechanism needs. The sizes are
    // identical before and after the stop and the -wal is empty in both readings, so the database was not
    // rewritten and there was nothing to checkpoint - which leaves "a row was deleted in place" as the
    // shape. What decides between the two remaining mechanisms is the TOTAL row count AFTER the stop: zero
    // means the engine replaced the jar, unchanged means it removed our row specifically, and those have
    // opposite fixes - one is about what the cookie service loaded at startup, the other about the row.
    const rowDetailAfterStop = await cookieRowDetail(userdataDir(profileA.id))
    note(`cookie row columns after the stop: ${rowDetailAfterStop}`)

    /**
     * Print the launcher's own account of the stop, because CI cannot see it any other way.
     *
     * `debug` writes to <dataDir>/logs/vfox.log rather than stdout, so the line that says whether the engine
     * exited on its own or was still alive when the graceful window expired has never appeared in a CI log -
     * and that line decides whether a lost state belongs to the forced kill or to the engine's own shutdown.
     * Two different mechanisms, two different fixes, one invisible line.
     */
    async function printLauncherStopLog(dataDir) {
      const file = path.join(dataDir, 'logs', 'vfox.log')
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        note(`could not read the launcher log at ${file}: ${error.message}`)
        return
      }
      const lines = text
        .split('\n')
        .filter(
          line =>
            line.includes('exited on its own') ||
            line.includes('STILL ALIVE') ||
            line.includes('graceful window') ||
            line.includes('engine process exited') ||
            line.includes('taskkill'),
        )
      if (lines.length === 0) {
        note(
          `the launcher log at ${file} has no stop line: either the engine never reported an exit, or the ` +
            'graceful window never ran. Both are findings, and neither is visible from the phase alone.',
        )
        return
      }
      for (const line of lines.slice(-6)) note(`launcher: ${line.trim()}`)
    }

    const stampBefore = await profileDirStamp(userdataDir(profileA.id))
    note(`profile directory before the relaunch: ${JSON.stringify(stampBefore)}`)

    const relaunched = await api(`/api/v1/profiles/${profileA.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const secondEndpoint = endpointOf(relaunched)
    if (!secondEndpoint) {
      fail(
        `profile ${profileA.name}: the relaunch returned no wsEndpoint — the API answered ` +
          `${JSON.stringify(relaunched).slice(0, 300)}`,
      )
      return { unread, checks }
    }
    // Two different endpoints = a genuinely new engine instance. The same endpoint would mean the
    // stop never happened at all, which the lock check above should already have caught.
    note(
      `relaunch: first endpoint ${JSON.stringify(wsEndpoint)} vs second ${JSON.stringify(secondEndpoint)}` +
        `${secondEndpoint === wsEndpoint ? ' — IDENTICAL, the stop did not take effect' : ''}`,
    )

    browser = await connect(secondEndpoint)
    let after
    // Read inside the session: asking a closed browser for its cookies can only ever answer "none",
    // which would be a check that cannot pass.
    //

    let apiSurvived = false
    try {
      const page = await browser.newPage()
      // The READER route: it sets nothing, so anything observed here came from the profile's own store.
      // `readState` is the shape the checks below were written against: `after.cookie` is the
      // Playwright cookie ENTRY (they ask it for `.expires`) and `after.document.cookie` is the string.
      // Reading the page directly here - as an earlier attempt did - gives a string in `cookie` and no
      // `document` at all, which is how a check ends up reading fields that are not there.
      after = await readState(page, reader)
      const jar = await page.context().cookies(reader)
      apiSurvived = jar.some(entry => entry.name === API_COOKIE)
    } finally {
      await browser.close()
    }

    // Which persistence path survived? The two answers mean different things and the combined failure
    // message above cannot express the difference: both gone means the profile's cookie store is not
    // persisted at all, while only the page-set one gone means the store works and something about a
    // cookie set by a page on a plain-HTTP loopback origin is what does not survive.
    note(
      `after the relaunch: page-set cookie ${after.document.cookie.includes(COOKIE) ? 'PRESENT' : 'GONE'}, ` +
        `API-set cookie ${apiSurvived ? 'PRESENT' : 'GONE'}`,
    )
    checks.push(
      apiSurvived
        ? 'the API-set cookie survived - the store persists, the page-set one is the difference'
        : 'neither cookie survived - the profile cookie store is not being persisted',
    )

    // Did the second engine actually open this profile directory? Firefox writes these on startup.
    const stampAfter = await profileDirStamp(userdataDir(profileA.id))
    const touched = Object.keys(stampAfter).filter(
      name => stampAfter[name] !== null && stampAfter[name] !== stampBefore[name],
    )
    note(`profile directory after the relaunch: ${JSON.stringify(stampAfter)}`)
    if (touched.length === 0) {
      note(
        'NO file in the profile directory changed during the relaunch: the second engine never opened ' +
          'this directory, so it launched against a different one. The state was never lost — it is in ' +
          'a directory the relaunched browser does not use.',
      )
    } else {
      note(
        `the relaunch touched: ${touched.join(', ')} — the second engine DID open this directory`,
      )
    }
    checks.push(
      touched.length === 0 ? 'relaunch used a DIFFERENT directory' : 'relaunch used this directory',
    )

    // Is the row STILL on disk after the relaunch? This separates the two remaining explanations:
    // the browser opened the profile but did not read that database (row present), or something
    // rewrote or cleared the database on startup (row gone). The directory stamp above already
    // proved the engine opened this profile, so the answer decides whether the defect is a read
    // path or an initialisation step.
    const rowAfterRelaunch = await cookieRowOnDisk(userdataDir(profileA.id), 2000)
    note(
      `cookie row in cookies.sqlite after the relaunch: ${
        rowAfterRelaunch === true
          ? 'PRESENT'
          : rowAfterRelaunch === false
            ? 'GONE'
            : rowAfterRelaunch
      }`,
    )
    checks.push(
      rowAfterRelaunch === true
        ? 'the row is still on disk after the relaunch'
        : 'the row is gone from disk after the relaunch',
    )

    const dbsAfter = await cookieDatabases(userdataDir(profileA.id))
    note(`cookie databases after the relaunch: ${JSON.stringify(dbsAfter)}`)
    if (dbsAfter.length > 1) {
      note(
        `MORE THAN ONE cookie database exists under the profile (${dbsAfter.length}): the phase polls the \
one at the root, and if the engine uses another, every verdict here has been about the wrong file.`,
      )
    }

    const lost = []
    if (!after.cookie) {
      lost.push(
        `the cookie ${COOKIE} (which had a ${COOKIE_EXPIRY_SECONDS}s expiry, so it had to reach cookies.sqlite)`,
      )
    } else if (!after.cookie.expires || after.cookie.expires < 0) {
      lost.push(
        `the expiry of ${COOKIE} — it came back as a session cookie, so it was never written to disk`,
      )
    }
    if (!after.document.cookie.includes(COOKIE)) {
      lost.push(`the cookie ${COOKIE} as the page sees it (the store and the context disagree)`)
    }
    if (after.document.storage !== 'durable') {
      lost.push(`localStorage['${STORAGE_KEY}']`)
    }
    if (lost.length > 0) {
      const attribution =
        onDisk === true
          ? 'the row was on disk before the stop, so the profile did not read back what it had written'
          : 'the row was NOT observed on disk before the stop, so this cannot distinguish a profile that ' +
            'is not durable from an engine killed before it flushed cookies.sqlite'
      fail(
        `profile ${profileA.name} lost its state across a stop and relaunch: ${lost.join('; ')} — ${attribution}` +
          (breakMode === 'durability-userdata'
            ? ' (userdata was removed between stop and relaunch)'
            : ''),
      )
      return { unread, checks }
    }
    checks.push('state survived the restart')
    pass(`profile ${profileA.name}: cookie and localStorage survived a full stop and relaunch`)

    // Isolation, in the same phase: durability with a shared directory would pass everything above.
    const launchedB = await api(`/api/v1/profiles/${profileB.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const endpointB = endpointOf(launchedB)
    if (!endpointB) {
      fail(
        `profile ${profileB.name}: the launch returned no wsEndpoint — ` +
          `the API answered ${JSON.stringify(launchedB).slice(0, 300)}`,
      )
      return { unread, checks }
    }
    browser = await connect(endpointB)
    let other
    try {
      const page = await browser.newPage()
      // Read-only, so B's page cannot manufacture the very state this check looks for.
      other = await readState(page, reader)
    } finally {
      await browser.close()
      await api(`/api/v1/profiles/${profileB.id}/stop`, { method: 'POST', body: '{}' })
    }

    if (other.cookie || other.document.storage === 'durable') {
      fail(
        `profile ${profileB.name} sees profile ${profileA.name}'s state — the two profiles share a ` +
          `browser directory: cookie=${JSON.stringify(other.cookie)} storage=${JSON.stringify(other.document.storage)}`,
      )
      return { unread, checks }
    }
    checks.push('state isolated between profiles')
    pass(
      `profile ${profileB.name} sees neither the cookie nor the localStorage entry of ${profileA.name}`,
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  return { unread, checks }
}
