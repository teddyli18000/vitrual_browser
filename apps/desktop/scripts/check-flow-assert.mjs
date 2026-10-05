/**
 * Proves the flow test's agreement assertion can fail, without a browser.
 *
 * `AGENTS.md` is explicit: a test that has never failed has not been shown to test anything. The
 * flow harness cannot run on the sandboxed development machine — Chromium needs piped stdio for
 * `--remote-debugging-pipe`, which the file sandbox denies — so its red run can only happen in CI.
 * That leaves a gap: nothing local would notice if the assertion were quietly reduced to "wait for
 * some status", which is exactly the shape that passes while the wiring is broken.
 *
 * This drives `waitForAgreement` from `flow-assert.mjs` with fake readers and asserts that it
 * **fails** on the two conditions the harness exists to catch, and passes on the healthy one:
 *
 *   1. dead SSE        — the row stays on `已停止` while the server has moved to `异常`
 *   2. optimistic paint — the row shows `运行中`, a state the server never reported
 *   3. healthy         — the row shows exactly what the server reports
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
    name: 'dead SSE: the row is stuck on 已停止 while the server moved on',
    expected: 'error',
    dom: () => ({ status: 'stopped', text: '已停止' }),
    server: () => ({ status: 'error', lastError: 'Version information not found' }),
    shouldFail: true,
    mustMention: ['renderer shows : stopped', 'server says    : error', 'they disagree'],
  },
  {
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
]

let failures = 0

for (const testCase of cases) {
  let error = null
  try {
    await waitForAgreement({
      expected: testCase.expected,
      what: 'the row to agree with the server',
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
const healthyWays = cases.length - wrongWays

console.log(
  `OK — the assertion resolves on agreement (${healthyWays} case(s)) and fails, naming both sides, on all ${wrongWays} ways the wiring can be wrong.`,
)
