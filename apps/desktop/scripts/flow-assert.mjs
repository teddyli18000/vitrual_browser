/**
 * The status wait the flow test is built from, with its readers injected.
 *
 * **WHAT THIS FUNCTION ACTUALLY DOES — read this before trusting its name.** It resolves as soon as
 * `readDom()` satisfies `expected`. It does **not** compare the two sides: `readServer` is called
 * only on the timeout path, to build a failure message that names both. So it detects *"the renderer
 * never reached X"*. It does **not** detect *"the renderer reached X while the server says Y"*.
 *
 * Agreement is a property of the **composite** in `flow-ui.mjs`, which is the point of the flow test:
 *
 *   1. read the server, then wait for the row to reach *that* status (`expected = server.status`);
 *   2. wait for the row to leave `已停止` (`expected = status => status !== 'stopped'`);
 *   3. after the wait, re-read the server and require the row to still agree.
 *
 * Step 1 is what catches an optimistic paint: a row that paints `运行中` on its own can never reach a
 * server that reports `异常`. Step 3 is what catches a row that reached the right status and then
 * stopped receiving pushes. Neither is this function's job.
 *
 * Making this function verify agreement itself was considered and rejected: a renderer legitimately
 * lags a push by a few hundred milliseconds, so it would need a tolerance, and a flaky tolerance is
 * worse than an accurate name. The name and this comment are the fix — `check-flow-assert.mjs`
 * asserts the boundary so it cannot drift back into a claim.
 *
 * It lives in its own module, taking `readDom`/`readServer` as arguments rather than a Playwright
 * locator, because **no browser can run on the sandboxed development machine**: Chromium's Mojo
 * platform channel is a named pipe, and the file sandbox denies those. With the readers injected the
 * behaviour can be exercised from Node against fakes, instead of being trusted until CI.
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
