/**
 * One minute-resolution clock, shared by every component that shows a relative time.
 *
 * Why it exists, and what it is NOT: this is a FRESHNESS mechanism, not a performance one. An earlier
 * version of this change was titled as a performance fix on the reasoning that a per-render `Date.now()`
 * was being recomputed for every row; an independent review read the code and showed that it was not -
 * `formatRelative` still runs per row, and a reactive `now` actually ADDS a dependency, so the table
 * re-renders once a minute where it previously did not. What it buys is that "3 minutes ago" stops being
 * stale until something else happens to trigger a render, and that the table and the detail panel agree
 * instead of disagreeing by up to a minute.
 *
 * The per-render cost is addressed where it actually is: `ProfilesView` computes its relative labels in
 * one `computed` map rather than calling the formatter twice per row inside the template.
 *
 * One interval for the whole app, reference-counted, so two components asking for the clock do not create
 * two timers - and so the timer stops when the last one unmounts.
 */

import { onUnmounted, type Ref, ref } from 'vue'

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let users = 0

/** The shared value. Reading it in a template or computed makes that thing re-evaluate each minute. */
export function minuteClock(): Ref<number> {
  return now
}

/**
 * Start the shared clock for the lifetime of the calling component. Safe to call from several components:
 * the interval is created for the first and cleared when the last one unmounts.
 */
export function useMinuteClock(): Ref<number> {
  users += 1
  timer ??= setInterval(() => {
    now.value = Date.now()
  }, 60_000)

  onUnmounted(() => {
    users -= 1
    if (users <= 0) {
      clearInterval(timer)
      timer = undefined
      users = 0
    }
  })

  return now
}
