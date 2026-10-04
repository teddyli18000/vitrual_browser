/**
 * Test harness: a real Fastify app wired to a fake Core and a fake SyncHandle, over a throwaway
 * data directory inside the workspace (`.cache/tmp`, set up by `scripts/dev-env.ps1`).
 *
 * It imports the built `dist/` output rather than `src/`, so the tests exercise exactly what ships.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { API_TOKEN_HEADER } from '@vfox/shared'

import { createApp } from '../../dist/app.js'
import { silentLogger } from '../../dist/logger.js'
import { createFakeCore } from './fake-core.mjs'
import { createFakeSync } from './fake-sync.mjs'

export const TEST_TOKEN = 'test-token-0123456789abcdef'

export async function createHarness(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'vfox-server-'))
  const core = createFakeCore({ dataDir })
  const sync = options.sync ?? createFakeSync()
  const context = await createApp({
    core,
    token: TEST_TOKEN,
    sync,
    logger: silentLogger,
    // No keepalive timer in tests: a stray interval would keep vitest from exiting.
    heartbeatMs: 0,
  })

  return {
    app: context.app,
    core,
    sync,
    context,
    dataDir,
    token: TEST_TOKEN,
    auth: { [API_TOKEN_HEADER]: TEST_TOKEN },
    dispose: async () => {
      await context.close()
      await sync.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

export function tick(ms = 10) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
