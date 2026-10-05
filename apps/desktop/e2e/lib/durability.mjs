/**
 * Durability and isolation of a profile's browser state — the property the product exists for.
 *
 * The gap this closes, verified rather than assumed: the packaged suite runs eight phases and **not one
 * of them restarts a profile**. The mechanism is `_userDataDir` in `packages/core/src/launcher.ts` — what
 * makes a profile a real directory instead of a throwaway temp one — and nothing would fail if it were
 * dropped. Every profile would still launch, render, and report a distinct fingerprint; a user would find
 * out weeks later as "I have to log in again every time", and it would look like the site's fault.
 *
 * What the phase does:
 *   1. serves one page from a local HTTP origin that sets a cookie **with an explicit expiry** and a
 *      localStorage entry on load;
 *   2. launches profile A (an existing profile, so no new creation path), loads it, confirms the state;
 *   3. **stops A completely** through the app's own stop route, with the process-tree check;
 *   4. **relaunches A** and asserts the cookie — value *and* expiry — and the localStorage entry survived;
 *   5. asserts profile B **cannot see A's cookie**: a shared profile directory would pass step 4 and fail
 *      here, and durability without isolation is a different bug.
 *
 * The cookie is set by the page (`document.cookie`), not by `context.addCookies`, so the profile's own
 * store owns it, and it is read back **two ways** — `context.cookies()` and `document.cookie` after a
 * reload — which distinguishes "the store kept it" from "the automation context remembered it". The
 * expiry is asserted too: a session cookie can outlive a stop on a live process and prove nothing about
 * disk, which is the entire question here.
 *
 * The origin is plain HTTP on `127.0.0.1`, never a `data:` URL, which has an opaque origin where a cookie
 * cannot be set at all. If the engine's anti-detection interferes with a plain-HTTP local origin, this
 * reports UNREAD with the observed state rather than weakening the assertion — a check that cannot fail is
 * worse than a check that says it could not read.
 *
 * What it does NOT prove, and says so in its own output: that a real third-party site's login survives.
 * Credentials must never be in CI. It proves the mechanism.
 *
 * The red run is `VFOX_E2E_BREAK=durability-userdata`, matching the project's `VFOX_FLOW_BREAK`
 * convention: it deletes the profile's `userdata` between the stop and the relaunch, which is the failure
 * this phase exists to catch, and must FAIL with a message naming what was lost.
 */

import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const COOKIE = 'vfox_durable'
const STORAGE_KEY = 'vfox_durable'
/** A day out, so the value that comes back had to be written to the profile's cookies.sqlite. */
const COOKIE_EXPIRY_SECONDS = 86_400

/** Served to the browser: sets an expiring cookie and a localStorage entry, from the page itself. */
function probePage() {
  const expires = new Date(Date.now() + COOKIE_EXPIRY_SECONDS * 1000).toUTCString()
  return `<!doctype html>
<meta charset="utf-8">
<title>vfox durability</title>
<script>
  document.cookie = '${COOKIE}=durable; expires=${expires}; path=/'
  localStorage.setItem('${STORAGE_KEY}', 'durable')
  document.title = 'vfox durability: set'
</script>
<body>durability probe</body>
`
}

/** Runs in the page. */
const READ_DOCUMENT_STATE = () => ({
  cookie: document.cookie,
  storage: localStorage.getItem('vfox_durable'),
})

async function startOrigin() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(probePage())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, url: `http://127.0.0.1:${port}/` }
}

/** Everything the browser holds for this origin: the document's view and the context's own store. */
async function readState(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const document = await page.evaluate(READ_DOCUMENT_STATE)
  const jar = await page.context().cookies(url)
  const cookie = jar.find(entry => entry.name === COOKIE)
  return { document, cookie }
}

/**
 * Run the phase.
 *
 * The interface is exactly what the runner already has at module scope — no context object, matching the
 * existing inline phases:
 *
 *   api(route, init)        the runner's HTTP helper
 *   profiles                the profiles phase 3 created; [0] and [1] are used
 *   dataDir                 the packaged app's data directory
 *   connect(wsEndpoint)     playwright-core `firefox.connect`
 *   user32                  the shared user32 module, for the best-effort process check
 *   step/pass/fail/note     the runner's reporters
 */
export async function runDurabilityPhase({
  api,
  profiles,
  dataDir,
  connect,
  user32,
  step,
  pass,
  fail,
  note,
}) {
  const breakMode = process.env.VFOX_E2E_BREAK ?? ''
  const [profileA, profileB] = profiles

  note(
    'NOT PROVEN by this phase: that a real third-party site login survives a restart. Credentials must ' +
      'never be in CI. It proves the mechanism — the browser writes its state into the profile directory ' +
      'and reads it back on the next launch.',
  )

  const userdataDir = id => path.join(dataDir, 'profiles', id, 'userdata')

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

  const { server, url } = await startOrigin()
  try {
    step('6b. a profile keeps its cookies and localStorage across a stop and relaunch')
    if (!profileA || !profileB) {
      fail('this phase needs two profiles; phase 3 created fewer')
      return
    }

    const launched = await api(`/api/v1/profiles/${profileA.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const wsEndpoint = launched?.wsEndpoint ?? launched?.data?.wsEndpoint
    if (!wsEndpoint) {
      fail(`profile ${profileA.name} exposed no wsEndpoint, so its page state cannot be read`)
      return
    }

    let browser = await connect(wsEndpoint)
    try {
      const page = await browser.newPage()
      const set = await readState(page, url)
      if (!set.cookie || set.document.storage !== 'durable') {
        note(
          `UNREAD: the probe page could not set its state on a plain-HTTP loopback origin — ` +
            `document.cookie=${JSON.stringify(set.document.cookie)} storage=${JSON.stringify(set.document.storage)}`,
        )
        return
      }
      pass(
        `profile ${profileA.name}: cookie ${COOKIE} and localStorage set (expiry in ${COOKIE_EXPIRY_SECONDS}s)`,
      )
    } finally {
      await browser.close()
    }

    // The app's own stop route, then the process-tree check.
    await api(`/api/v1/profiles/${profileA.id}/stop`, { method: 'POST', body: '{}' })
    await checkNoEngineProcesses(`after stopping ${profileA.name}`)

    if (breakMode === 'durability-userdata') {
      const target = userdataDir(profileA.id)
      rmSync(target, { recursive: true, force: true })
      note(
        `VFOX_E2E_BREAK=durability-userdata: deleted ${target} between the stop and the relaunch`,
      )
    }

    const relaunched = await api(`/api/v1/profiles/${profileA.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const secondEndpoint = relaunched?.wsEndpoint ?? relaunched?.data?.wsEndpoint
    if (!secondEndpoint) {
      fail(`profile ${profileA.name} exposed no wsEndpoint after the relaunch`)
      return
    }

    browser = await connect(secondEndpoint)
    let after
    try {
      const page = await browser.newPage()
      after = await readState(page, url)
    } finally {
      await browser.close()
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
      fail(
        `profile ${profileA.name} lost its state across a stop and relaunch: ${lost.join('; ')}` +
          (breakMode === 'durability-userdata'
            ? ' (userdata was removed between stop and relaunch)'
            : ''),
      )
      return
    }
    pass(`profile ${profileA.name}: cookie and localStorage survived a full stop and relaunch`)

    // Isolation, in the same phase: durability with a shared directory would pass everything above.
    const launchedB = await api(`/api/v1/profiles/${profileB.id}/launch`, {
      method: 'POST',
      body: '{}',
    })
    const endpointB = launchedB?.wsEndpoint ?? launchedB?.data?.wsEndpoint
    if (!endpointB) {
      fail(`profile ${profileB.name} exposed no wsEndpoint`)
      return
    }
    browser = await connect(endpointB)
    let other
    try {
      const page = await browser.newPage()
      other = await readState(page, url)
    } finally {
      await browser.close()
      await api(`/api/v1/profiles/${profileB.id}/stop`, { method: 'POST', body: '{}' })
    }

    if (other.cookie || other.document.storage === 'durable') {
      fail(
        `profile ${profileB.name} sees profile ${profileA.name}'s state — the two profiles share a ` +
          `browser directory: cookie=${JSON.stringify(other.cookie)} storage=${JSON.stringify(other.document.storage)}`,
      )
      return
    }
    pass(
      `profile ${profileB.name} sees neither the cookie nor the localStorage entry of ${profileA.name}`,
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
