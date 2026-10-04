/**
 * A fake `SyncHandle` for the server tests.
 *
 * The synchroniser is the one part of the API that reaches a real browser, and this machine cannot
 * spawn one at all (the sandbox denies the piped stdio Playwright needs). The routes therefore
 * take their handle as a dependency, and this object implements the frozen `SyncHandle` interface
 * in memory: it records the calls it received, publishes transitions to `on('change')` listeners
 * exactly as the real engine does, and can be told to fail with a specific `SyncError`.
 *
 * It validates its own output through the shared zod schema, so a drift in `@vfox/shared` breaks
 * the fake as loudly as it would break the real handle. Plain ESM on purpose — see
 * `sandbox-preload.mjs`.
 */

import { SyncSessionSchema } from '@vfox/shared'

export function createFakeSync(options = {}) {
  let session = null
  const listeners = new Set()

  const clone = () =>
    session === null ? null : { ...session, slaveProfileIds: [...session.slaveProfileIds] }

  const notify = () => {
    for (const listener of [...listeners]) listener(clone())
  }

  const fake = {
    /** Every `start()` input, in order. */
    starts: [],
    /** Every `tile()` request, in order. */
    tiles: [],
    stops: 0,
    closes: 0,
    /** Thrown instead of succeeding while set; a real `SyncError` from `@vfox/sync`. */
    failure: undefined,

    /** `failWith(new SyncError('...', 'already_active'))`, or `failWith(undefined)` to recover. */
    failWith(error) {
      fake.failure = error
    },

    /** Publishes a transition the routes did not cause (e.g. the master window closing). */
    emit(next) {
      session = next === null ? null : SyncSessionSchema.parse(next)
      notify()
    },

    async start(input) {
      if (fake.failure) throw fake.failure
      fake.starts.push(input)
      session = SyncSessionSchema.parse({
        id: options.id ?? 'fake-session-1',
        masterProfileId: input.masterProfileId,
        slaveProfileIds: [...input.slaveProfileIds],
        active: true,
        startedAt: '2026-10-04T00:00:00.000Z',
        mirroredEvents: 0,
      })
      notify()
      return clone()
    },

    async stop() {
      fake.stops += 1
      if (session === null) return
      session = null
      notify()
    },

    current: clone,

    async tile(request) {
      if (fake.failure) throw fake.failure
      fake.tiles.push(request)
    },

    on(_event, callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },

    async close() {
      fake.closes += 1
      await fake.stop()
    },
  }

  return fake
}
