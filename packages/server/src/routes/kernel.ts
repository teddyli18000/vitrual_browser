import type { KernelProgress } from '@vfox/shared'
import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { conflict, ok } from '../errors.js'
import type { RouteDeps } from '../types.js'

/**
 * Kernel (Camoufox engine) status and install.
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

  app.post(API_ROUTES.kernelInstall, async (_request, reply) => {
    if (installing) throw conflict('A kernel install is already in progress')

    installing = true
    const fallback = hub.kernelProgressFromCore
      ? undefined
      : (value: KernelProgress) => hub.publishKernel(value)

    hub.publishKernel(progress('checking', 'checking engine'))
    void (async () => {
      try {
        fallback?.(progress('downloading', 'installing engine'))
        const info = await core.kernel.install()
        fallback?.(progress('done', info.version ? `kernel ${info.version} ready` : 'kernel ready'))
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
}

function progress(phase: KernelProgress['phase'], message: string | null): KernelProgress {
  // percent / receivedBytes / totalBytes stay null: this layer has no byte-level information.
  return { phase, percent: null, receivedBytes: null, totalBytes: null, message }
}
