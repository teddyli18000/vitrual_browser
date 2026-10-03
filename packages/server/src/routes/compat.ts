import type { ProfileRuntime } from '@vfox/shared'
import { API_ROUTES } from '@vfox/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { ok } from '../errors.js'
import { findProfile } from '../resolve.js'
import type { RouteDeps } from '../types.js'
import { parse } from '../validate.js'
import { launch } from './profiles.js'

const CompatIdSchema = z.object({ id: z.string().min(1) })

/**
 * VirtualBrowser-compatible aliases, so automation scripts written against that product keep
 * working against VFox.
 *
 * `debuggingPort` is always `null` and that is deliberate: the Camoufox engine is patched Firefox
 * speaking Playwright's Juggler protocol — it has **no Chrome DevTools Protocol endpoint**, so
 * there is no debugging port to report. Inventing one would make every script fail at connect time.
 * Attach with `firefox.connect(wsEndpoint)` from `playwright-core` instead.
 */
export interface CompatBrowser {
  profileId: string
  wsEndpoint: string | null
  debuggingPort: null
}

export interface CompatBrowserEntry extends CompatBrowser {
  status: ProfileRuntime['status']
  pid: number | null
}

function toCompat(profileId: string, runtime: ProfileRuntime): CompatBrowser {
  return {
    profileId,
    // Passed through from the core; never synthesized here.
    wsEndpoint: runtime.wsEndpoint,
    debuggingPort: null,
  }
}

export function registerCompatRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { core } = deps

  app.post(API_ROUTES.launchBrowser, async (request) => {
    const { id } = parse(CompatIdSchema, request.body)
    const profile = await findProfile(core, id)
    const runtime = await launch(core, profile)
    return ok(toCompat(profile.id, runtime))
  })

  app.post(API_ROUTES.closeBrowser, async (request) => {
    const { id } = parse(CompatIdSchema, request.body)
    const profile = await findProfile(core, id)
    const current = core.runtime.get(profile.id)
    const runtime =
      current.status === 'stopped' ? current : await core.runtime.stop(profile.id)
    return ok(toCompat(profile.id, runtime))
  })

  /**
   * Every profile with its runtime status, not only the running ones — `status` is what tells the
   * two apart, and a script that wants open browsers filters on `status === 'running'`.
   * Served on GET (the usual verb) and POST (scripts that post everything).
   */
  const listBrowsers = async () => {
    const profiles = await core.profiles.list()
    const entries: CompatBrowserEntry[] = profiles.map((profile) => {
      const runtime = core.runtime.get(profile.id)
      return { ...toCompat(profile.id, runtime), status: runtime.status, pid: runtime.pid }
    })
    return ok(entries)
  }

  app.get(API_ROUTES.browserList, listBrowsers)
  app.post(API_ROUTES.browserList, listBrowsers)
}
