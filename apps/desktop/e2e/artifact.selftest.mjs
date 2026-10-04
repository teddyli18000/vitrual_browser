#!/usr/bin/env node
/**
 * artifact.selftest.mjs — prove the structural guards can FAIL.
 *
 * A guard that has only ever been green has not been shown to test anything; it is believed rather
 * than trusted. `checkWebglDatabase` was proven against the real shipped v0.2.0 artifact, but
 * `checkNoTestCode` passed on every layout it had been run against — which shows it does not
 * false-positive and nothing more. This closes that gap and keeps it closed: if someone later widens
 * a rule or a pattern until it can no longer match, this fails.
 *
 * The last two cases matter as much as the failures. Test files inside `node_modules` are legitimate
 * — production dependencies ship them — and a guard that goes red on those gets switched off within
 * a week, which is worse than not having it.
 *
 * Usage:
 *   node apps/desktop/e2e/artifact.selftest.mjs
 */
import process from 'node:process'
import { checkNoTestCode, checkWebglDatabase } from './lib/artifact.mjs'

/** Build the minimal asar shape `asarPaths` walks. */
function buildArtifact(paths) {
  const header = { files: {} }
  for (const entry of paths) {
    const parts = entry.split('/')
    let node = header
    for (let index = 0; index < parts.length; index += 1) {
      const leaf = index === parts.length - 1
      node.files[parts[index]] ??= leaf ? {} : { files: {} }
      node = node.files[parts[index]]
    }
  }
  return { asarHeader: header, unpackedEntries: [] }
}

const cases = [
  { name: 'a clean layout', paths: ['out/main/index.cjs', 'package.json'], expect: true },
  {
    name: 'the assertion suite packed into the app',
    paths: ['out/main/index.cjs', 'e2e/packaged-e2e.mjs'],
    expect: false,
  },
  {
    name: 'the evidence collector packed into the app',
    paths: ['out/main/index.cjs', 'e2e/collect-evidence.mjs'],
    expect: false,
  },
  {
    name: 'a spec file outside node_modules',
    paths: ['out/main/index.cjs', 'out/main/thing.spec.mjs'],
    expect: false,
  },
  {
    name: 'a test file INSIDE node_modules (legitimate, must stay green)',
    paths: ['node_modules/dep/test/thing.test.js'],
    expect: true,
  },
  {
    name: 'an e2e directory inside node_modules (legitimate, must stay green)',
    paths: ['node_modules/dep/e2e/run.js'],
    expect: true,
  },
]

let wrong = 0
console.log('=== checkNoTestCode: must fail when it should, and not false-positive ===')
for (const testCase of cases) {
  const result = checkNoTestCode(buildArtifact(testCase.paths))
  const ok = result.ok === testCase.expect
  if (!ok) wrong += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${testCase.name}  ok=${result.ok} expected=${testCase.expect}`,
  )
  if (!result.ok && result.problems[0]) console.log(`        ${result.problems[0].slice(0, 110)}`)
}

console.log('\n=== checkWebglDatabase: the same discrimination, on the defect that shipped ===')
const sealed = checkWebglDatabase({
  ...buildArtifact(['node_modules/camoufox-js/dist/data-files/webgl_data.db']),
  unpackedEntries: [],
})
const unpacked = checkWebglDatabase({
  ...buildArtifact(['node_modules/camoufox-js/dist/data-files/webgl_data.db']),
  unpackedEntries: ['node_modules/camoufox-js/dist/data-files/webgl_data.db'],
})
const sealedOk = sealed.ok === false
const unpackedOk = unpacked.ok === true
if (!sealedOk) wrong += 1
if (!unpackedOk) wrong += 1
console.log(`${sealedOk ? 'PASS' : 'FAIL'}  sealed inside the asar  ok=${sealed.ok} expected=false`)
console.log(
  `${unpackedOk ? 'PASS' : 'FAIL'}  unpacked beside it      ok=${unpacked.ok} expected=true`,
)

if (wrong > 0) {
  console.error(`\n${wrong} case(s) wrong — a guard has lost its discriminating power.`)
  process.exit(1)
}
console.log(
  '\nBoth guards discriminate: they fail when they should and stay green when they should.',
)
