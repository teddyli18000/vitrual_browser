/**
 * `@vfox/sync` — the window synchroniser.
 *
 * One click, one keystroke, one scroll in a **master** window is replayed into every **slave**
 * window, using Playwright's own input APIs so the events are indistinguishable from real input.
 * This is the feature competing anti-detect browsers sell as their paid tier (窗口同步器 /
 * `window-sync`); here it ships to everyone.
 *
 * How it works, and why it needs no native code for the mirroring itself:
 *
 * 1. Attach to each running profile with `firefox.connect(wsEndpoint)`. The engine runs in
 *    `launchServerShared` mode, so several clients may be connected at once and detaching only
 *    closes *our* connection — the user's window stays open.
 * 2. Instrument the master window with one exposed binding plus an init script that reports real
 *    (`isTrusted`) input events: `mousedown`, `mouseup`, `click`, `wheel`, `keydown`, `keyup` and
 *    a throttled `mousemove`. Each report carries the pointer position and the master viewport.
 * 3. Replay into every slave page with `page.mouse.move/down/up/click/wheel` and
 *    `page.keyboard.down/up`, mapping coordinates by the viewport ratio and clamping them into
 *    the slave viewport. A slave without a page waits for one instead of dropping the event.
 * 4. Slaves are never instrumented, so a slave can never become a source; the session additionally
 *    refuses a slave that resolves to the master's own browser, and drops reports from any profile
 *    that is not the active master.
 * 5. Back-pressure lives per slave: `mousemove` is dropped before clicks and keys, and the master
 *    is never awaited.
 *
 * Tiling is the one part that needs the OS: Playwright cannot move a native window, so `tile()`
 * calls `user32.dll` through koffi.
 */

import type { CoreLogger } from '@vfox/core'
import type { SyncSession, SyncStart, TileRequest } from '@vfox/shared'
import { connectBrowser } from './browser.js'
import { createSyncWith } from './session.js'
import { createTileBackend } from './tile.js'

export type { SyncErrorCode } from './errors.js'
export { SyncError } from './errors.js'

/** Where a profile's browser can be reached, as resolved by the caller (the server). */
export interface SyncTarget {
  wsEndpoint: string | null
  pid: number | null
  name?: string
}

export interface SyncOptions {
  /**
   * Supplied by the caller (the server). Resolve a profile id to its live browser endpoint, or
   * `undefined` when the profile does not exist.
   *
   * May be asynchronous. The membership half of the question ("is this a profile at all?") is
   * answered from the profile store, which reads `profiles.json` per call so that a profile created
   * by another process is visible without a restart — so a caller that has to hit the disk must be
   * able to say so here rather than invent a cache. Returning `undefined` is `unknown_profile`
   * (404); a known profile whose browser is not running is `not_running` (409).
   */
  resolve: (profileId: string) => SyncTarget | undefined | Promise<SyncTarget | undefined>
  logger?: CoreLogger
}

export interface SyncHandle {
  start(input: SyncStart): Promise<SyncSession>
  stop(): Promise<void>
  current(): SyncSession | null
  tile(req: TileRequest): Promise<void>
  on(event: 'change', cb: (session: SyncSession | null) => void): () => void
  close(): Promise<void>
}

export function createSync(options: SyncOptions): SyncHandle {
  return createSyncWith(options, { connect: connectBrowser, tile: createTileBackend() })
}
