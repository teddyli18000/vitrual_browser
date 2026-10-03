import type { Core } from '@vfox/core'
import type { Health } from '@vfox/shared'
import { API_ROUTES, PRODUCT_NAME } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'

import { ok } from '../errors.js'
import { packageVersion } from '../version.js'

export async function buildHealth(core: Core): Promise<Health> {
  return {
    ok: true,
    product: PRODUCT_NAME,
    version: packageVersion(),
    pid: process.pid,
    kernel: await core.kernel.info(),
    runningProfiles: core.runtime.list().filter((runtime) => runtime.status === 'running').length,
  }
}

export function registerHealthRoutes(app: FastifyInstance, core: Core): void {
  app.get(API_ROUTES.health, async () => ok(await buildHealth(core)))
}
