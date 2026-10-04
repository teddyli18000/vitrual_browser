/**
 * Window synchroniser routes — the HTTP face of `@vfox/sync`.
 *
 * The session itself lives in the `SyncHandle` that `startServer` constructs once over the core's
 * runtime registry; these handlers only translate HTTP into that handle and its failures back into
 * the `ApiResult` envelope. Every transition the handle reports is pushed on the `sync` SSE event
 * by `EventHub`, so a client never polls.
 *
 * Two layers decide what an unknown profile means, and both answer with the same vocabulary:
 * this file resolves an id-or-name against the profile store (so a name works exactly as it does
 * on every other route, and only a store-supplied id is ever handed downstream), and the handle
 * resolves the resulting id against the runtime registry.
 */

import type { Core } from '@vfox/core'
import { API_ROUTES, SyncStartSchema, TileRequestSchema } from '@vfox/shared'
import type { SyncErrorCode } from '@vfox/sync'
import type { FastifyInstance } from 'fastify'

import { HttpError, ok } from '../errors.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'

/**
 * HTTP status for every `SyncErrorCode`. Exhaustive by type — `satisfies` makes a new code in
 * `@vfox/sync` a compile error here rather than a silent 500 at runtime.
 *
 * `attach_failed` is 502: the request was well formed and the profile is running, but the browser
 * behind its `wsEndpoint` could not be reached, which is an upstream failure rather than a bad
 * request. `closed` is 503: the synchroniser has been shut down (a request racing server
 * shutdown), which is temporary and not the caller's fault.
 */
const SYNC_STATUS = {
  invalid_input: 400,
  unknown_profile: 404,
  not_running: 409,
  already_active: 409,
  closed: 503,
  attach_failed: 502,
  tiling_unavailable: 501,
} as const satisfies Record<SyncErrorCode, number>

type MappedSyncCode = keyof typeof SYNC_STATUS

/**
 * `@vfox/sync` is imported lazily by `startServer`, so its `SyncError` class is not in this
 * module's runtime graph — the code carried by the error is the contract, and it is checked
 * against the table above rather than against a class identity. `Object.hasOwn` rather than `in`:
 * an inherited name like `toString` is not a synchroniser code.
 */
function isSyncError(error: unknown): error is Error & { code: MappedSyncCode } {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && Object.hasOwn(SYNC_STATUS, code)
}

/** Runs one handle call, turning a synchroniser failure into the matching HTTP error. */
async function viaSync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!isSyncError(error)) throw error
    throw new HttpError(SYNC_STATUS[error.code], error.code, error.message)
  }
}

/**
 * The API accepts an exact profile name wherever it takes an id, and every call downstream must
 * use the id the *store* supplied (see `resolve.ts`). A profile that does not exist answers with
 * the synchroniser's own code — `unknown_profile` / 404 — so a client can branch on one vocabulary
 * for every way a sync request can fail.
 */
async function profileIdOf(core: Core, idOrName: string): Promise<string> {
  try {
    return (await findProfile(core, idOrName)).id
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      throw new HttpError(404, 'unknown_profile', error.message)
    }
    throw error
  }
}

export function registerSyncRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core, sync } = deps

  app.get(API_ROUTES.sync, async () => ok(sync.current()))

  app.post(API_ROUTES.syncStart, async request => {
    const input = parse(SyncStartSchema, request.body)
    const masterProfileId = await profileIdOf(core, input.masterProfileId)
    const slaveProfileIds: string[] = []
    for (const idOrName of input.slaveProfileIds) {
      slaveProfileIds.push(await profileIdOf(core, idOrName))
    }
    return ok(await viaSync(() => sync.start({ masterProfileId, slaveProfileIds })))
  })

  app.post(API_ROUTES.syncStop, async () => {
    // Stopping when nothing is active is a no-op, not an error.
    await viaSync(() => sync.stop())
    return ok({ ok: true })
  })

  app.post(API_ROUTES.syncTile, async request => {
    const input = parse(TileRequestSchema, request.body)
    const profileIds: string[] = []
    for (const idOrName of input.profileIds) {
      profileIds.push(await profileIdOf(core, idOrName))
    }
    await viaSync(() => sync.tile({ ...input, profileIds }))
    return ok({ ok: true })
  })
}
