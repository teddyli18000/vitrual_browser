/**
 * The agreement assertion the flow test rests on, with its readers injected.
 *
 * The whole point of `flow-ui.mjs` is that the **server** is the authority: a row that shows a status
 * the server does not have is a renderer that invented it, and a row still showing `已停止` while the
 * server has moved on is a dead SSE stream. Both are invisible to a screenshot and to the server
 * suite, and both must fail loudly with the two values named.
 *
 * This lives in its own module, taking `readDom`/`readServer` as arguments rather than a Playwright
 * locator, for one reason: **the browser cannot run on the sandboxed development machine** (Chromium
 * needs piped stdio for `--remote-debugging-pipe`, which the file sandbox denies). With the readers
 * injected, the discrimination can be exercised from Node against fakes — so the assertion is shown
 * failing on exactly the conditions it exists to catch, instead of being trusted until CI.
 */

/**
 * @param {object} options
 * @param {string | ((status: string) => boolean)} options.expected
 *        status the renderer must reach, or a predicate over it. A predicate is what the launch step
 *        uses — "the row must leave 已停止" — because `starting` can be brief enough that polling
 *        misses it, and waiting for that one value would cost a full timeout in the common case.
 * @param {string} options.what              human description of what is being waited for
 * @param {() => Promise<{status: string, text?: string}>} options.readDom
 * @param {() => Promise<{status: string, lastError?: string|null}>} options.readServer
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {string} [options.note]            extra context for the failure message (e.g. a sabotage flag)
 * @returns {Promise<{status: string, text: string}>}
 */
export async function waitForAgreement({
  expected,
  what,
  readDom,
  readServer,
  timeoutMs = 60_000,
  pollMs = 150,
  note = '',
}) {
  const matches = typeof expected === 'function' ? expected : status => status === expected
  const deadline = Date.now() + timeoutMs
  let last = { status: 'unknown', text: '' }

  for (;;) {
    last = await readDom()
    if (matches(last.status)) return last

    if (Date.now() >= deadline) {
      let server = { status: 'unreadable' }
      try {
        server = await readServer()
      } catch (error) {
        server = { status: `unreadable (${error.message})`, lastError: null }
      }
      // Both values, always. A bare timeout is what a reviewer cannot act on.
      const lines = [
        `timeout after ${timeoutMs} ms waiting for ${what}.`,
        `  renderer shows : ${last.status}${last.text ? ` (${last.text})` : ''}`,
        `  server says    : ${server.status}${server.lastError ? ` (${server.lastError})` : ''}`,
      ]
      if (last.status !== server.status) {
        lines.push(
          '  they disagree — the renderer is showing a state the server does not have, or has not',
          '  received the state the server pushed (a dead SSE stream looks exactly like this)',
        )
      }
      if (note) lines.push(`  ${note}`)
      throw new Error(lines.join('\n'))
    }
    await new Promise(done => {
      setTimeout(done, pollMs)
    })
  }
}
