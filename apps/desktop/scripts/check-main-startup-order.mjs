#!/usr/bin/env node
/**
 * check-main-startup-order.mjs — the single-instance lock must be taken AFTER the portable redirect.
 *
 * WHY THIS IS A TEXT CHECK AND NOT A TEST
 *
 * `requestSingleInstanceLock()` keys its lock on `app.getPath('userData')` **at the moment of the
 * call** (issue #89). The behaviour that follows from the order — two portable folders can run at
 * once, the same folder twice cannot — needs a real Electron process. The only place that runs is
 * phase 8 of `apps/desktop/e2e/packaged-e2e.mjs`, fifteen minutes into a Windows job that cannot be
 * started locally at all (the sandbox denies the pipes Chromium and Electron need).
 *
 * So this is the fast tripwire for the one regression that matters: someone moving the lock back
 * above the redirect, because the old order looked deliberate. It asserts the order **in the
 * source**, which is not proof of behaviour — the packaged phase is that, and this file does not
 * pretend otherwise. What it buys is a failure in about a minute, on every pull request, in the job
 * that already runs the UI guard chain.
 *
 * The file is read as text on purpose: importing `src/main/index.ts` would import `electron`.
 *
 * Usage: node scripts/check-main-startup-order.mjs
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const mainFile = resolve(join(here, '..', 'src', 'main', 'index.ts'))

let source
try {
  source = readFileSync(mainFile, 'utf8')
} catch (error) {
  console.error(`cannot read ${mainFile}: ${error.message}`)
  process.exit(1)
}

const failures = []

/**
 * Locate a marker and report it. A missing marker is a failure, never a pass: a check that cannot
 * find what it is looking for must not report that what it is looking for is fine.
 *
 * The patterns are anchored to the **call shape** on purpose. The first version of this file
 * searched for `requestSingleInstanceLock\s*\(` and matched the phrase inside the explanatory
 * comment above the code, so it failed on a file whose order was already correct — a check that
 * fails while printing proof it should pass, which is the same class of defect as one that cannot
 * fail. The matched text is printed for every marker so a reader can see what was actually found
 * rather than trusting that the pattern found the right thing.
 */
function find(name, pattern) {
  const match = pattern.exec(source)
  if (!match) {
    failures.push(
      `could not find ${name} in src/main/index.ts — this check must not pass on a file it could not read`,
    )
    return -1
  }
  console.log(`  ${name}: ${JSON.stringify(match[0])}`)
  return match.index
}

console.log(`main process file: ${mainFile}`)
console.log('markers found:')

const resolveAt = find(
  'data location resolved',
  /const\s+location\s*=\s*resolveDataLocation\s*\(\s*\)/,
)
const redirectAt = find('userData redirected', /app\.setPath\s*\(\s*['"]userData['"]\s*,/)
const lockAt = find(
  'instance lock taken',
  /if\s*\(\s*!\s*app\.requestSingleInstanceLock\s*\(\s*\)\s*\)/,
)
const handlerAt = find('second-instance handled', /app\.on\s*\(\s*['"]second-instance['"]/)

console.log(
  `offsets: resolve=${resolveAt} redirect=${redirectAt} lock=${lockAt} handler=${handlerAt}`,
)

if (failures.length === 0) {
  if (!(resolveAt < redirectAt)) {
    failures.push(
      "resolveDataLocation() must run before app.setPath('userData', …) — the redirect needs to know where the data directory is",
    )
  }
  if (!(redirectAt < lockAt)) {
    failures.push(
      "requestSingleInstanceLock() is taken BEFORE app.setPath('userData', …). It keys its lock on " +
        "app.getPath('userData') at the moment of the call, so every copy on the machine would share " +
        'one lock keyed on the default %APPDATA%\\VFox: two independent portable folders could not ' +
        'run at once, and a portable copy would block an installed one (issue #89)',
    )
  }
  if (!(resolveAt < lockAt)) {
    failures.push(
      'resolveDataLocation() must run before requestSingleInstanceLock() — otherwise the lock cannot be keyed on the data directory',
    )
  }
  if (handlerAt === -1 || !(lockAt < handlerAt)) {
    failures.push(
      "the 'second-instance' handler must be registered after the lock is taken — it is what focuses the existing window when the same folder is launched twice",
    )
  }
}

if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  process.exit(1)
}

console.log(
  '\nOK — the data location is resolved and redirected before the single-instance lock, so the lock is\n' +
    'keyed on the data directory. Behavioural proof is phase 8 of apps/desktop/e2e/packaged-e2e.mjs.',
)
