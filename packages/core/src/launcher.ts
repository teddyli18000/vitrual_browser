/**
 * Camoufox launcher.
 *
 * ONE real, visible browser window per profile, backed by the profile's own durable
 * `userdata` directory, plus a Playwright websocket endpoint external automation can attach to.
 *
 * The option object is assembled by `toServerOptions()` and handed to `firefox.launchServer()`.
 * camoufox-js's own `launchServer()` is deliberately not used: it is the same two lines
 * (`firefox.launchServer({ ...(await launchOptions(opts)), port, wsPath })`, dist/server.js) but it
 * leaves camoufox-js's mangled proxy in place — see the proxy note in `toServerOptions`.
 *
 * ── Private-API dependency (read before touching the option list) ────────────────────────────────
 * `firefox.launchServer()` is normally non-persistent: without help it launches a throwaway temp
 * profile. playwright-core 1.60.0 exposes one internal hook that changes that —
 * `node_modules/playwright-core/lib/coreBundle.js:52555-52586`:
 *
 *     if (options2._userDataDir !== void 0) {
 *       launchOptions = validator({ ...launchOptions, userDataDir: options2._userDataDir }, ...);
 *       const context2 = await playwright2[name].launchPersistentContext(progress2, options2._userDataDir, launchOptions);
 *       return context2._browser;                       // wrapped in a BrowserServer below
 *     }
 *     ...
 *     browserServer.process    = () => browser.options.browserProcess.process;
 *     browserServer.wsEndpoint = () => wsEndpoint;
 *     browser.options.browserProcess.onclose = (exitCode, signal) => browserServer.emit('close', exitCode, signal);
 *
 * So two undocumented options are load-bearing:
 *   - `_userDataDir`   the durable per-profile directory. Without it every profile silently becomes
 *                      a throwaway temp profile and the product's core promise breaks.
 *   - `_sharedBrowser` selects `launchServerShared`, which keeps the browser alive when the last
 *                      automation client disconnects. Without it a user's window would vanish the
 *                      moment their script exits.
 *
 * The `-profile` guard in `firefox.defaultArgs` (coreBundle.js:44190) is unrelated: it only throws
 * when a *caller* injects `-profile` into `args`; Playwright owns that argument itself.
 *
 * `playwright-core` is therefore pinned to the exact verified version and
 * `test/launcher.guard.test.ts` fails CI if these hooks ever disappear.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { spawnSync } from 'node:child_process'
import type { Profile } from '@vfox/shared'
import type { LaunchOptions } from 'camoufox-js'
import { firefox } from 'playwright-core'
import { addonPaths, excludeDefaultAddons, listAddons } from './addons.js'
import { camoufoxModule } from './camoufox.js'
import { acceptedKeys, dropUnacceptedKeys, withUnknownKeyTolerance } from './engine-config.js'
import { type FingerprintWarning, toEngineOptions } from './fingerprint.js'
import { resolveEngineDir } from './kernel.js'

export interface BrowserExit {
  exitCode: number | null
  signal: string | null
}

/** A running browser process owned by the runtime registry. */
export interface BrowserHandle {
  /** OS pid of the browser launcher process, i.e. the root of the process tree to kill. */
  readonly pid: number | null
  /** Playwright (Juggler) endpoint; attach with `firefox.connect(wsEndpoint)`. */
  readonly wsEndpoint: string
  close(): Promise<void>
  onExit(listener: (exit: BrowserExit) => void): void
}

export interface LaunchContext {
  profile: Profile
  /** The profile's isolated browser data directory. */
  userDataDir: string
  warn: (message: string) => void
  debug: (message: string) => void
}

export type BrowserLauncher = (context: LaunchContext) => Promise<BrowserHandle>

/** Everything `firefox.launchServer()` receives, including the two private hooks. */
export type ServerOptions = Record<string, unknown>

/**
 * Build the exact option object for `firefox.launchServer()`.
 *
 * Exported so the invariants below are testable without spawning a browser. `engineDirOverride`
 * exists for the same reason: the addon wiring depends on what the *engine* ships (its default
 * addons), and a test must be able to point that at a fixture rather than at a 500 MB install.
 */
export async function toServerOptions(
  profile: Profile,
  userDataDir: string,
  warn: FingerprintWarning,
  engineDirOverride?: string,
): Promise<ServerOptions> {
  // Imported lazily: camoufox-js resolves its install directory at module load time, and
  // `createCore({ kernelDir })` sets CAMOUFOX_INSTALL_DIR before the first launch.
  const { launchOptions } = (await import(camoufoxModule())) as typeof import('camoufox-js')
  const engine = toEngineOptions(profile.fingerprint, profile.proxy, warn)
  const engineDir = engineDirOverride ?? (await resolveEngineDir())

  // Layer 1: never hand the engine a config key it does not accept. The engine's own
  // `properties.json` is the authority, and this covers both our pinned identity values and the
  // user's raw `fingerprint.config` escape hatch. Unreadable schema → launch as-is.
  const { config } = dropUnacceptedKeys(engine.config, await acceptedKeys(engineDir), warn)

  // The addons this profile loads, read once. They must be handed to `launchOptions` **as an
  // option**: camoufox-js turns them into `config.addons` itself, and assigning `options.addons`
  // afterwards does nothing at all — the option is an input, not an output (measured: the addon
  // never reached `CAMOU_CONFIG`, and only the engine's own default was loaded).
  const installed = await listAddons(userDataDir)
  const excludeDefaults = await excludeDefaultAddons(
    engineDir,
    installed.flatMap(addon => (addon.id === null ? [] : [addon.id])),
  )

  // Layer 2: `canvas:aaOffset`, `canvas:aaCapOffset` and `window.history.length` are merged by
  // camoufox-js itself (`dist/utils.js:424-433`, `:531-534`), so no config we pass can prevent them
  // from reaching its validator. Retry with each rejected key suppressed, and warn by name.
  //
  // Every attempt gets a FRESH copy of the config: a failed attempt has already had the rejected key
  // written into the object it was given as an own enumerable property, and reusing that object would
  // carry the key straight past the suppression into the next attempt's validator.
  const options = (await withUnknownKeyTolerance(
    async () =>
      (await launchOptions({
        ...engine,
        config: { ...config },
        // The profile's stored device identity, re-injected verbatim. Without it the engine
        // generates a brand new device on every launch (see src/identity.ts), which is the one thing
        // this product must never do. `identity.fingerprint` is an open record in the shared schema
        // because it is whatever the engine's generator produced, hence the cast.
        fingerprint: profile.identity?.fingerprint as LaunchOptions['fingerprint'],
        headless: profile.launch.headless,
        // 4. Addons. The engine loads addons from **paths given at launch** (`addons` is a Camoufox
        //    config key), and it requires each path to be an extracted directory containing
        //    manifest.json — `confirmPaths` throws `InvalidAddonPath` otherwise, which would fail
        //    every launch. `listAddons` only returns directories whose manifest parses, so a
        //    half-deleted addon cannot get that far.
        //
        //    Three traps live in these two lines, all of them read out of camoufox-js 0.12.0
        //    (`dist/utils.js:384-390` and `:545-561`):
        //
        //    (a) It MUTATES the array it is given: `addDefaultAddons` pushes the engine's own default
        //        addon paths into it, then assigns that same array to `config.addons`. So each
        //        attempt must build a fresh array — including every retry below — or the defaults
        //        accumulate, once per retry and once per launch.
        //    (b) It OVERWRITES `config.addons` unconditionally, which is why the raw
        //        `fingerprint.config` escape hatch silently does nothing here: our key is replaced
        //        by the list built from this option. The option is the only working route.
        //    (c) The paths must be ABSOLUTE. Camoufox issue #399 is exactly this failure: relative
        //        paths launch a browser with no error and no addons.
        addons: addonPaths(userDataDir, installed),
        //    A profile that has its own copy of an addon the engine also ships would otherwise load
        //    one gecko id twice, from two paths. Excluding the engine's copy is not a preference the
        //    user expresses — it is the only correct outcome, so it is decided here, and the key
        //    list is derived from the engine's own manifests rather than hard-coded.
        exclude_addons: excludeDefaults,
      })) as ServerOptions,
    warn,
  )) as ServerOptions

  // 1. Proxy. camoufox-js rebuilds the proxy as `{ server: new URL(server).origin, ... }`
  //    (dist/utils.js:310-334 and :563-568). Per the WHATWG URL spec `origin` is the literal
  //    string "null" for every non-special scheme, so a socks5 profile would reach Playwright as
  //    `server: "null"` — measured, not theorised:
  //        launchOptions({ proxy: { server: 'socks5://127.0.0.1:1080', ... } }).proxy
  //        => { server: 'null', username: 'u', password: 'p' }
  //    Passing the proxy into `launchOptions()` is still required (its geoip lookup uses the correct
  //    `.href`), but the value Playwright finally sees is ours.
  options.proxy = engine.proxy

  // 2. Viewport. camoufox-js's `Camoufox()` helper sets `viewport: null` for persistent launches
  //    (dist/sync_api.js:23-27) precisely because "Playwright applies a 1280x720 viewport by
  //    default, which makes Juggler ask the content window to become 1280x720" (dist/utils.js:242-261)
  //    — which would resize the window away from the spoofed `window.outerWidth/outerHeight`.
  //    `launchServer()` does not do that for us, and the raw protocol cannot express
  //    `viewport: null` (the scheme at coreBundle.js:21826 is a non-nullable object — passing null
  //    fails with `viewport: expected object, got null`). The protocol-level equivalent, and what
  //    the client itself converts `viewport: null` into (coreBundle.js:57151), is
  //    `noDefaultViewport: true`; `validateBrowserContextOptions` then skips the 1280x720 default
  //    (coreBundle.js:46954).
  options.noDefaultViewport = true

  // 3. The two private hooks documented at the top of this file.
  options._userDataDir = userDataDir
  options._sharedBrowser = true

  return options
}

export const launchCamoufox: BrowserLauncher = async ({
  profile,
  userDataDir,
  warn,
  debug,
}: LaunchContext): Promise<BrowserHandle> => {
  const options = await toServerOptions(profile, userDataDir, warn)
  // The spawn line is the first thing support needs; Playwright does not expose the argv after a
  // successful launch, so log what we handed it.
  debug(
    `spawning engine for profile ${profile.id}: ${String(options.executablePath)} ` +
      `headless=${String(options.headless)} args=${JSON.stringify(options.args ?? [])}`,
  )
  const server = await firefox.launchServer(options)

  const browserProcess = server.process()
  const pid = browserProcess?.pid ?? null
  const wsEndpoint = server.wsEndpoint()
  debug(`launched profile ${profile.id} (pid ${pid ?? 'unknown'}) at ${wsEndpoint}`)

  let exitListener: ((exit: BrowserExit) => void) | null = null
  let exited: BrowserExit | null = null
  // The process exit event is the same signal Playwright uses to emit `BrowserServer`'s own
  // `close` event (coreBundle.js:52582-52585), but it is typed, so it needs no cast.
  browserProcess?.on('exit', (exitCode, signal) => {
    exited = { exitCode, signal }
    debug(`profile ${profile.id}: engine process exited (code ${exitCode}, signal ${signal})`)
    exitListener?.(exited)
  })

  const startUrl = profile.launch.startUrl
  if (startUrl && startUrl !== 'about:blank') {
    try {
      await openStartUrl(wsEndpoint, startUrl, debug)
    } catch (error) {
      // The window is already open and visible; a start URL that will not load is the user's
      // problem to see in that window, not a reason to fail the launch.
      warn(`profile ${profile.id}: could not open start URL ${startUrl}: ${errorMessage(error)}`)
    }
  }

  return {
    pid,
    wsEndpoint,
    async close() {
      try {
        // Graceful first: Playwright sends Juggler `Browser.close` and only falls back to
        // `taskkill /T /F` when that fails or times out.
        await server.close()
      } catch (error) {
        warn(`profile ${profile.id}: browser server did not close cleanly: ${errorMessage(error)}`)
      }
      // Give the engine a moment to exit AND FLUSH before the hard kill. Firefox writes cookies
      // through a WAL that is only checkpointed during a clean shutdown: killing it the instant
      // server.close() resolves can orphan the row the page just set inside the -wal side file,
      // which the next launch then discards - the profile loses state that WAS written. The window
      // is short because the engine is already closing; the wait ends the moment it is gone.
      //
      // Two things this must NOT do, both learned the hard way:
      //   - Do not decide liveness from `tasklist`'s exit code. Measured on this machine, it exits 1
      //     for a process that IS alive (and the dev sandbox makes it print "Access denied" for any
      //     other process at all), so an exit-code probe ends the wait on its first iteration and the
      //     grace period silently becomes a no-op. `process.kill(pid, 0)` sends no signal and only
      //     reports whether the pid exists - one call, no child process, no parsing.
      //   - Do not block the event loop waiting. A synchronous wait here would freeze the embedded
      //     API and its SSE stream for the whole window, on every stop.
      if (browserProcess && browserProcess.pid) {
        const startedWaiting = Date.now()
        const deadline = startedWaiting + 5_000
        while (Date.now() < deadline && isProcessAlive(browserProcess.pid)) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        // WHICH PATH WAS TAKEN, said out loud. Everything time-based in this area has been falsified
        // twice, and "the state still dies" cannot distinguish a process that exited on its own from one
        // that was killed at the deadline - two different mechanisms with two different fixes. This one
        // line is what makes the next CI run decisive instead of suggestive.
        const waited = Date.now() - startedWaiting
        if (isProcessAlive(browserProcess.pid)) {
          debug(
            `engine pid ${String(browserProcess.pid)} was STILL ALIVE after ${String(waited)}ms - the ` +
              'graceful window expired and the hard kill is about to land mid-shutdown',
          )
        } else {
          debug(
            `engine pid ${String(browserProcess.pid)} exited on its own after ${String(waited)}ms - the ` +
              "graceful window was enough, so a state lost now is lost by the engine's own shutdown",
          )
        }
      }
      killProcessTree(pid, debug)
    },
    onExit(listener) {
      exitListener = listener
      if (exited) {
        listener(exited)
      }
    },
  }
}

/**
 * Open the profile's start URL in the window the engine already created.
 *
 * `firefox.connect()` on a connected browser closes the *connection* (`_shouldCloseConnectionOnClose`
 * is set in `connectToBrowser`, coreBundle.js:57807) and `_sharedBrowser` makes the server ignore
 * the close request, so this detaches without touching the browser.
 */
async function openStartUrl(
  wsEndpoint: string,
  url: string,
  debug: (m: string) => void,
): Promise<void> {
  const browser = await firefox.connect(wsEndpoint)
  try {
    const context = browser.contexts()[0]
    if (!context) {
      throw new Error('no persistent browser context was exposed by the engine')
    }
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(url)
    debug(`opened start URL ${url}`)
  } finally {
    await browser.close()
  }
}

/**
 * Hard guarantee that no orphan survives a stop: kills the browser process *and its children*.
 *
 * Playwright already runs the same command as its own fallback (coreBundle.js:8690-8696), but only
 * after a graceful close fails or times out; the product requires zero orphans unconditionally.
 * A dead pid makes `taskkill` exit non-zero, which is expected and ignored.
 */
/**
 * Is this pid still running?
 *
 * `process.kill(pid, 0)` sends signal 0, which is not a signal: it performs the permission and
 * existence checks and reports them as an error. It is one syscall with no child process, no exit
 * code to interpret and no parsing - unlike `tasklist`, whose exit code is 1 for a live process on
 * this machine, which is how a liveness probe can end up always answering "gone".
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killProcessTree(pid: number | null, debug?: (message: string) => void): void {
  if (pid === null || process.platform !== 'win32') {
    return
  }
  // stdio 'ignore': taskkill's output is noise, and piped stdio is denied by the dev sandbox.
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  debug?.(
    `taskkill /PID ${pid} /T /F -> ${result.error ? result.error.message : `exit ${result.status}`}`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
