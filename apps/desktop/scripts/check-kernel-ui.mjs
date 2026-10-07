#!/usr/bin/env node
/**
 * check-kernel-ui.mjs — the renderer must READ the kernel failure code, not the prose around it.
 *
 * WHY THIS EXISTS (issue #110)
 *
 * The core records `runtime.errorCode = 'kernel_missing'` precisely so the interface can branch on a
 * code rather than match an English sentence — a rule this repository has written down, and which was
 * half-implemented for a whole release: the code existed, the branch did not. Worse, the branch that
 * did exist keyed on the GLOBAL `kernel.info.installed`, which is a different question. A profile
 * pinned to a kernel that was deleted is refused while a perfectly good default kernel is installed,
 * and that user got a message and no button.
 *
 * This is a source-level guard, and it says so: it asserts that the renderer still reads the code and
 * still offers the action. It cannot prove the row RENDERS — that needs a browser, and
 * `apps/desktop/scripts/screenshot-ui.mjs` carries the behavioural half of this in the
 * `ui-screenshots` job. What this catches, in about a second and in the job that runs on every pull
 * request, is the regression that is easy to make and invisible in a screenshot: going back to
 * matching the message, or to the global flag.
 *
 * Every pattern it looks for is reported with the line it matched, and a missing pattern is a failure
 * rather than a pass — a guard that cannot find what it is looking for must not report that what it is
 * looking for is fine.
 *
 * Usage: node scripts/check-kernel-ui.mjs
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const renderer = resolve(join(here, '..', 'src', 'renderer', 'src'))

const failures = []
let checked = 0

/**
 * @param {string} file      path under src/renderer/src
 * @param {string} label     what the pattern is for, in the failure message
 * @param {RegExp} pattern   must appear in the file
 */
function expect(file, label, pattern) {
  checked += 1
  const full = join(renderer, file)
  let source
  try {
    source = readFileSync(full, 'utf8')
  } catch (error) {
    failures.push(`cannot read ${file}: ${error.message}`)
    return
  }
  const match = pattern.exec(source)
  if (!match) {
    failures.push(`${file}: ${label} — no line matches ${String(pattern)}`)
    return
  }
  const line = source.slice(0, match.index).split('\n').length
  console.log(`  ${file}:${line}  ${match[0].trim().slice(0, 84)}`)
}

console.log('reading the renderer:')

// 1. The code is what the store reads. `lastError` is prose and must not be the branch condition.
expect(
  'stores/runtime.ts',
  'errorCodeOf must read `errorCode` from the runtime record',
  /errorCodeOf[\s\S]{0,200}?\.errorCode/,
)
expect(
  'stores/runtime.ts',
  "kernelMissing must be derived from the 'kernel_missing' code",
  /kernelMissing[\s\S]{0,200}?===\s*'kernel_missing'/,
)

// 2. The row offers the action, and it is the ROW's own condition — not the global "no engine at all".
expect(
  'views/ProfilesView.vue',
  'the row action must be gated on the per-profile code',
  /runtime\.kernelMissing\(\s*row\.id\s*\)/,
)
expect(
  'views/ProfilesView.vue',
  'the row action must route to the engine panel',
  /function fixKernel\([\s\S]{0,400}?router\.push\(/,
)
expect(
  'views/ProfilesView.vue',
  'the launch failure must re-read that profile rather than assume the SSE push arrived',
  /runtime\.refreshOne\(\s*profile\.id\s*\)/,
)

// 3. The engine panel reads what the API reports and can remove a kernel.
expect(
  'views/SettingsView.vue',
  'the panel must list the installed kernels the API reports',
  /kernel\.kernels/,
)
expect('views/SettingsView.vue', 'the panel must offer removal', /removeKernel\(/)
expect(
  'views/SettingsView.vue',
  'install must name a version rather than always taking the default',
  /kernel\.install\(\s*targetVersion/,
)

// 4. The pin, and the sentence that makes it meaningful.
expect('components/ProfileDialog.vue', 'the form must bind the pin', /v-model="draft\.kernel"/)
expect(
  'components/ProfileDialog.vue',
  'the form must say that changing the kernel changes the fingerprint',
  /field\.kernelChangeWarning/,
)
expect(
  'forms/profile-draft.ts',
  'the payload must carry the pin when one was chosen',
  /\.\.\.\(draft\.kernel \? \{ kernel: draft\.kernel \} : \{\}\)/,
)

console.log(`\npatterns checked: ${checked}`)

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(
  '\nOK — the renderer reads the kernel failure code, offers the action on the row, lists the installed\n' +
    'kernels, and states what changing the pin does. Behavioural proof is the ui-screenshots job.',
)
