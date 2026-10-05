/**
 * Pins the behaviour of the status wait the flow test is built from, without a browser.
 *
 * **Read the scope before the results.** `waitForAgreement` resolves as soon as the renderer reaches
 * `expected`; it does not compare the two sides. So the cases below assert what it *does* — it
 * resolves on the expected status, and it fails, naming both sides, when the status never arrives.
 * The case that shows the boundary is `dom reaches expected while the server disagrees`, which
 * resolves **successfully**: that is the function's scope, and agreement is asserted by the
 * *composite* in `flow-ui.mjs` (read the server → wait for the row to reach it → re-read and require
 * it to still agree). See the header of `flow-assert.mjs`.
 *
 * Why this file exists at all: no browser can run on the sandboxed development machine — Chromium's
 * Mojo platform channel is a named pipe and the file sandbox denies those — so the flow harness's red
 * run can only happen in CI. That would leave nothing local to notice if the wait were quietly
 * reduced to something that passes while the wiring is broken.
 *
 * Runs in a few hundred milliseconds and needs no browser, no renderer build and no server.
 *
 *   node scripts/check-flow-assert.mjs
 */

import { waitForAgreement } from './flow-assert.mjs'

const TIMEOUT_MS = 600

const cases = [
  {
    name: 'healthy: the row shows the status the server reports',
    expected: 'error',
    dom: () => ({ status: 'error', text: '异常' }),
    server: () => ({ status: 'error', lastError: 'Version information not found' }),
    shouldFail: false,
  },
  {
    // The composite's step 1 catches this: the flow reads the server, sees `error`, and waits for the
    // row to reach it. Here the row never does, so the wait times out and names both sides.
    name: 'dead SSE: the row is stuck on 已停止 while the server moved on',
    expected: 'error',
    dom: () => ({ status: 'stopped', text: '已停止' }),
    server: () => ({ status: 'error', lastError: 'Version information not found' }),
    shouldFail: true,
    mustMention: ['renderer shows : stopped', 'server says    : error', 'they disagree'],
  },
  {
    // A timeout too, and worth being precise about: this fails only because `expected` is `error`,
    // which an optimistically-painted `running` row can never reach. It is NOT this function
    // detecting disagreement — the boundary case at the end of this list is the honest statement of
    // what the function does, and the composite is what makes the paint impossible to miss.
    name: 'optimistic paint: the row shows 运行中, which the server never reported',
    expected: 'error',
    dom: () => ({ status: 'running', text: '运行中' }),
    server: () => ({ status: 'error', lastError: 'spawn EPERM' }),
    shouldFail: true,
    mustMention: ['renderer shows : running (运行中)', 'server says    : error', 'they disagree'],
  },
  {
    // The launch step's first assertion, in predicate form.
    name: 'predicate: the row must leave 已停止, and does',
    expected: status => status !== 'stopped',
    dom: () => ({ status: 'error', text: '异常' }),
    server: () => ({ status: 'error', lastError: null }),
    shouldFail: false,
  },
  {
    name: 'predicate: dead SSE leaves the row on 已停止',
    expected: status => status !== 'stopped',
    dom: () => ({ status: 'stopped', text: '已停止' }),
    server: () => ({ status: 'error', lastError: 'Version information not found' }),
    shouldFail: true,
    mustMention: ['renderer shows : stopped', 'server says    : error'],
  },
  {
    name: 'unreadable server: the failure still names both sides',
    expected: 'running',
    dom: () => ({ status: 'stopped', text: '已停止' }),
    server: () => {
      throw new Error('connection refused')
    },
    shouldFail: true,
    mustMention: ['renderer shows : stopped', 'server says    : unreadable (connection refused)'],
  },
  {
    // THE BOUNDARY, asserted rather than claimed — and it is the only case here whose expectation is
    // "resolves".
    //
    // The row satisfies `expected` while the server says something else entirely, and the wait
    // resolves successfully, because comparing the two sides is not its job. `readServer` is not
    // consulted at all on this path.
    //
    // If someone later makes the function check agreement here, this case goes red and tells them the
    // property lives in the composite: `flow-ui.mjs` reads the server and passes its status as
    // `expected`, so a row painting `运行中` on its own can never reach a server reporting `异常`; and
    // each step re-reads the server after the wait, so a row that stops receiving pushes is caught
    // too. Do not "fix" this by loosening the expectation — move the property, or leave it where it
    // is and keep this case as the record of the boundary.
    name: 'boundary: the row reaches expected while the server disagrees — the wait still resolves',
    expected: 'running',
    dom: () => ({ status: 'running', text: '运行中' }),
    server: () => ({ status: 'stopped', lastError: null }),
    shouldFail: false,
  },
]

let failures = 0

for (const testCase of cases) {
  let error = null
  try {
    await waitForAgreement({
      expected: testCase.expected,
      // Deliberately not "the row to agree with the server": reaching the status is what this waits
      // for, and the message should not describe a condition the function does not test.
      what: 'the row to reach the expected status',
      timeoutMs: TIMEOUT_MS,
      pollMs: 50,
      readDom: async () => testCase.dom(),
      readServer: async () => testCase.server(),
    })
  } catch (caught) {
    error = caught
  }

  const failed = error !== null
  const verdict = failed === testCase.shouldFail ? 'ok  ' : 'FAIL'
  if (verdict === 'FAIL') failures += 1
  console.log(`${verdict}  ${testCase.name}`)
  console.log(
    `      expected ${testCase.shouldFail ? 'a failure' : 'success'}, got ${failed ? 'a failure' : 'success'}`,
  )

  if (error) {
    for (const line of error.message.split('\n')) console.log(`      | ${line}`)
    for (const needle of testCase.mustMention ?? []) {
      if (!error.message.includes(needle)) {
        failures += 1
        console.log(`      MISSING from the message: "${needle}"`)
      }
    }
  } else if (testCase.mustMention && testCase.mustMention.length > 0) {
    failures += 1
    console.log('      expected a failure message containing:', testCase.mustMention.join(' / '))
  }
  console.log('')
}

if (failures > 0) {
  console.error(
    `${failures} problem(s): the agreement assertion does not discriminate as intended.`,
  )
  process.exit(1)
}

const wrongWays = cases.filter(testCase => testCase.shouldFail).length
const resolves = cases.length - wrongWays

// Deliberately NOT "the assertion resolves on agreement": it does not, and saying so was the
// overclaim this file now documents. Agreement is the composite's property (see flow-assert.mjs).
console.log(
  `OK — the status wait resolves on the expected status (${resolves} case(s), including the boundary where the server disagrees) ` +
    `and fails, naming both sides, on all ${wrongWays} ways the status can fail to arrive.`,
)
