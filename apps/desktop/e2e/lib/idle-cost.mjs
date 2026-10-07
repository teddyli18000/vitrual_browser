/**
 * What the running engines cost while nobody is touching them.
 *
 * Why this exists: the owner reported the app as "not slow to start - sluggish in use", and every
 * measurement this repository had was about OUR work - the renderer, the store, the event stream. None
 * of it looked at the other half of the machine: a profile is a real Firefox, and a user who keeps two
 * or three open is running two or three browsers beside the Electron shell. If that is where the
 * sluggishness lives, no amount of renderer tuning will touch it, and the honest answer is to say so
 * rather than to keep optimising the part that is not the problem.
 *
 * It samples `os.cpus()` deltas over a window while the profiles sit idle, and reports the total CPU
 * across all cores. That is deliberately a REPORT and not an assertion: this is a shared CI runner, the
 * number is not a user's machine, and the engine's idle cost is the engine's - failing a build over it
 * would be failing our code for someone else's behaviour. What it gives is a number to compare against
 * a user's report, which is what was missing.
 */

import { cpus } from 'node:os'

/** Total busy time across every core, in milliseconds, from the cumulative per-core counters. */
function cpuTimes() {
  let idle = 0
  let total = 0
  for (const core of cpus()) {
    for (const value of Object.values(core.times)) total += value
    idle += core.times.idle
  }
  return { idle, total }
}

/**
 * Sample the whole machine for `windowMs` and report how busy it was.
 *
 * `note` is the runner's reporter; the phase deliberately never calls `fail`.
 */
export async function reportIdleCost({ note, step, windowMs = 10_000, profilesRunning }) {
  const before = cpuTimes()
  await new Promise(resolve => setTimeout(resolve, windowMs))
  const after = cpuTimes()

  const totalDelta = after.total - before.total
  const idleDelta = after.idle - before.idle
  const busyPercent = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0
  const cores = cpus().length

  step(
    `idle cost: ${busyPercent.toFixed(1)}% of ${cores} cores busy over ${windowMs / 1000}s ` +
      `with ${profilesRunning} profile(s) running and nothing driving them`,
  )
  note(
    `the machine was ${busyPercent.toFixed(1)}% busy while ${profilesRunning} profile(s) sat idle. ` +
      'This is a shared CI runner, not a desktop, and a profile is a real browser: the number is here to ' +
      'be compared against a user report, not to pass or fail. If a user sees sluggishness while using a ' +
      'browser window, this is the half of the machine that no renderer change can help.',
  )

  return { busyPercent, cores, profilesRunning }
}
