# AGENTS.md — @vfox/sync

The window synchroniser: input performed once in a **master** profile is replayed into every
**slave** profile, plus tiling of the real OS windows. This is the feature competing anti-detect
browsers sell as their paid tier; it ships to everyone here.

## Surface

Frozen in `src/index.ts` — `createSync(options)`, `SyncTarget`, `SyncOptions`, `SyncHandle`, and
`SyncError` (with a `code` the HTTP layer can map onto `ApiError`). Session types come from
`@vfox/shared`; never redefine them.

## How it works

| File | Responsibility |
| --- | --- |
| `browser.ts` | The only place `playwright-core` is touched. Structural `BrowserLike`/`ContextLike`/`PageLike` interfaces are the seam that lets every unit test run against a fake browser. |
| `master.ts` | Attach, `context.exposeBinding` + `context.addInitScript`, re-install into already-open documents, detach (disposes the binding and the init script, then closes the *connection*). |
| `mirror.ts` | The injected page listener (a string: it must run in the page), payload normalisation, and replay through Playwright's own input APIs. |
| `mapping.ts` | Viewport-ratio coordinate mapping, clamping, and the short-TTL per-page viewport cache. |
| `slave.ts` | One queue and one drain loop per slave: back-pressure, page waiting, replay ordering. |
| `session.ts` | The session state machine (`start`/`stop`/`current`/`tile`/`on('change')`/`close`). |
| `tile.ts` | `user32.dll` through koffi: work area, `EnumWindows` by pid, `MoveWindow`, `ShowWindow`, `SetForegroundWindow`. |
| `tile-grid.ts` | Pure grid arithmetic inside the monitor work area. |

## Invariants (do not regress)

- **A slave is never instrumented.** The binding and the init script exist only in the master's
  context, the injected listener ignores `!event.isTrusted`, and the session drops any report whose
  source profile is not the active master. `start()` additionally refuses a slave that resolves to
  the master's own browser (same wsEndpoint or pid).
- **The master is never awaited.** The binding callback enqueues and returns; a slow slave only
  slows itself. `mousemove` is dropped before clicks, keys and wheel events.
- **Detaching must not close a window.** `browser.close()` on a connected browser closes the
  connection; the engine's `_sharedBrowser` keeps the window. `scripts/smoke-sync.mjs` asserts it.
- **No polling.** Transitions are pushed from real events. The one timer coalesces the diagnostic
  event counter (armed by an event, self-disarming, `unref()`ed).
- **Coordinates are viewport-relative, resolved per slave at replay time.** Never reuse master
  geometry: the engine re-rolls six `CAMOU_CONFIG` keys on every launch, so two windows of the same
  profile do not even render identically.
- `SyncSession.mirroredEvents` is a local diagnostic counter. It is never reported anywhere.

## Verification

CI runs the real thing: `pnpm --filter @vfox/sync test`, and
`node packages/sync/scripts/smoke-sync.mjs` after a build (two profiles through `@vfox/core`, a
click in the master, the slave must report it, then both windows must survive the detach).

Locally, **no browser can be spawned or connected to** (the sandbox denies piped stdio →
`spawn EPERM`), and **vitest cannot run at all** in the sandbox (esbuild's service, then Vite's
`net use`). To execute the unit tests locally anyway: compile `src` + `test` with `tsc` into a
throwaway directory that keeps the relative layout, and run vitest over the emitted JavaScript with
`--configLoader native --root <that dir>` and `resolve.preserveSymlinks: true`. Delete the directory
afterwards; never commit it.

`scripts/probe-tiling.mjs` verifies the FFI layer without a browser:

```powershell
pnpm --filter @vfox/sync build
node packages/sync/scripts/probe-tiling.mjs              # work area + monitors (read-only)
node packages/sync/scripts/probe-tiling.mjs --move <pid> # moves that pid's largest visible window
```

## Gotchas

- `page.viewportSize()` returns `null` for the engine's persistent windows (`noDefaultViewport`), so
  the slave viewport is measured in the page (`window.innerWidth/innerHeight`) and cached briefly.
- `exposeBinding` installs into every frame that already exists; `addInitScript` only covers
  documents created later, which is why open documents get an explicit `page.evaluate`.
- `koffi` is loaded lazily and only on Windows: a missing dependency, a non-Windows host or a
  display index that does not exist must fail with `tiling_unavailable`, never silently.
- Only *visible* windows are tiled, and the largest one wins — the engine creates invisible helper
  windows. UWP/Store apps own their window through `ApplicationFrameHost`, so pid matching will not
  find them; the engine's Firefox is a classic Win32 process and is unaffected.
- The workspace uses pnpm's **hoisted** `node-linker`, so `playwright-core` and `koffi` resolve from
  the root `node_modules`; `packages/sync/node_modules` only holds the `@vfox/*` links.
- `playwright-core` is pinned to exactly `1.60.0` (camoufox-js peer range `<1.61.0`).
