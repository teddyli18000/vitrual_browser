import type { KernelProgress } from '@vfox/shared'
import { API_ROUTES, KernelInstallRequestSchema, KernelRemoveRequestSchema } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { conflict, notFound, ok } from '../errors.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'

/**
 * Kernel (Camoufox engine) status, install and remove.
 *
 * Several kernels coexist under `<engine root>/kernels/<version>/`; `GET` reports all of them with
 * their disk cost, and each profile pins the one it launches with. Installing a version that is
 * already present is a no-op, and installing never re-points an existing profile.
 *
 * The install downloads ~493 MB, so it can never run inside the HTTP response: the route returns
 * `{ started: true }` immediately and the download reports itself on the `kernel` SSE event.
 * Progress comes from `core.kernel.on('progress')`; when a core cannot report it, coarse phase
 * transitions are published instead so the UI still gets a completion signal.
 */
export function registerKernelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core, hub, logger } = deps
  let installing = false

  app.get(API_ROUTES.kernel, async () => ok(await core.kernel.info()))

  app.post(API_ROUTES.kernelInstall, async (request, reply) => {
    if (installing) throw conflict('A kernel install is already in progress')

    // Validated before the 202 so an untested version is a 400 the caller can act on, instead of a
    // background failure that only ever appears on the SSE stream.
    const { version } = parse(KernelInstallRequestSchema, request.body ?? {})

    installing = true
    const fallback = hub.kernelProgressFromCore
      ? undefined
      : (value: KernelProgress) => hub.publishKernel(value)

    hub.publishKernel(
      progress('checking', version ? `checking engine ${version}` : 'checking engine'),
    )
    void (async () => {
      try {
        fallback?.(progress('downloading', 'installing engine'))
        const info = await core.kernel.install(version)
        fallback?.(
          progress(
            'done',
            // `info.installed` is the authority: `#runInstall` returns without throwing when it finds no
            // launcher, so reporting 'ready' on `version` alone announced a successful install that had
            // installed nothing. Same shape as the GeoIP bug — a success signal never checked against reality.
            info.installed
              ? info.version
                ? `kernel ${info.version} ready`
                : 'kernel ready'
              : 'kernel install finished, but no engine was found — check the log',
          ),
        )
        logger.info('kernel install finished', info)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        hub.publishKernel(progress('error', message))
        logger.error('kernel install failed', message)
      } finally {
        installing = false
      }
    })()

    reply.code(202)
    return ok({ started: true })
  })

  app.post(API_ROUTES.kernelRemove, async request => {
    const { version } = parse(KernelRemoveRequestSchema, request.body)
    try {
      return ok(await core.kernel.remove(version))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // "Not installed" is a 404 and "in use by these profiles" is a 409: the caller acts on those
      // differently, so they must not arrive as the same status. Anything else is a genuine failure
      // and is rethrown — mapping every unexpected error onto 409 told the GUI to show an "in use"
      // dialog for a bug.
      if (/is not installed/.test(message)) {
        throw notFound(message)
      }
      if (/is in use by/.test(message)) {
        throw conflict(message)
      }
      throw error
    }
  })
}

function progress(phase: KernelProgress['phase'], message: string | null): KernelProgress {
  // percent / receivedBytes / totalBytes stay null: this layer has no byte-level information.
  return { phase, percent: null, receivedBytes: null, totalBytes: null, message }
}
