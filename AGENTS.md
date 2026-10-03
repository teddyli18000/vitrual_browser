# AGENTS.md — VFox

Operational context for agents and contributors working in this repository.

## What this is

VFox is a **lightweight, telemetry-free anti-detect ("fingerprint") browser manager for Windows**.
It is not a browser fork: it drives the open-source [Camoufox](https://camoufox.com/) engine
(a patched Firefox with engine-level, C++ fingerprint spoofing) through
[`camoufox-js`](https://github.com/apify/camoufox-js), and adds the product layer around it.

Mental model: **every profile is a VM instance.**

| VM concept | VFox equivalent |
| --- | --- |
| Virtual hardware | the profile's fingerprint config (`FingerprintConfig`) |
| Virtual disk | `<dataDir>/profiles/<id>/userdata` (a real, isolated browser profile dir) |
| Start / stop | launch / stop a real, visible Firefox window |
| Clone | copy the profile dir + config |
| Export / import | zip / unzip the profile dir + config |

## Non-negotiable product rules

1. **Zero telemetry.** No analytics, no crash reporting, no update phone-home, no "anonymous usage
   statistics". The only outbound traffic the product itself may generate is:
   (a) the Camoufox kernel download on first run, (b) the user's own configured proxy, and
   (c) the GeoIP lookup the engine performs when `fingerprint.geoip` is enabled.
   Any new outbound call must be documented in `README.md` and justified in the PR.
2. **Zero paywall, zero promotion, zero cloud.** Every feature ships to everyone: no licence check, no
   activation, no "pro" tier, no referral or invite links, no ads, no community-group or website
   promotion inside the app, and no hosted service of ours. There is deliberately **no cloud-sync /
   WebDAV backup package** — the project operates no servers and never asks the user for an account.
   Moving or backing up a profile is done with per-profile export/import to a local zip
   (`profiles.exportZip` / `profiles.importZip`). Do not add a remote endpoint, an account, or a
   payment surface; if a task seems to require one, stop and ask.
3. **Real windows.** `launch.headless` defaults to `false`. Profiles open visible windows; a
   headless mode exists only for CI and automation and must never become the default.
4. **Lightweight by construction.** See the invariants below. A feature that adds an idle process,
   a polling loop, a heavyweight dependency or a background service needs an explicit justification
   in the PR description.
5. **No secrets in the repo.** Proxy credentials live in the user's local profile store only.

## Lightweight invariants

- One Electron window, one Node core process. No sidecar runtimes, no helper daemons.
- **No polling.** Runtime state is pushed over SSE (`/api/v1/events`) from process events.
- No auto-updater, no crash reporter, no `electron-devtools`, no devtools in production builds.
- Profiles are launched strictly on demand and killed with their whole process tree on stop.
- Profile storage is plain JSON + plain directories — no database, no native modules, so a profile
  can be copied, zipped, backed up and diffed with ordinary tools.
- UI dependency budget: Vue 3 + Vite + Element Plus + Pinia. Nothing else without justification.

## Layout

```
packages/shared     Frozen domain contract (zod schemas + inferred types + HTTP route table)
packages/core       Profile store, fingerprint mapping, engine launcher, runtime registry
packages/server     Fastify HTTP API + SSE + MCP (Streamable HTTP)
packages/cli        `vfox` command line tool
apps/desktop        Electron shell (main + preload) and the Vue 3 renderer
scripts/            dev-env, kernel fetch/path, packaging helpers
.github/workflows/  ci.yml (validate) and release.yml (tag -> Windows installer -> Release)
```

Dependency direction is strictly one-way:
`shared <- core <- server <- {cli, desktop}`. `core` and `server` must never import Electron.

## Frozen contract

`packages/shared/src/schemas.ts` and `routes.ts` are the single source of truth. The launcher, the
HTTP API, the CLI and the GUI all validate against them, so the contract cannot drift. Changing a
schema or route is a cross-package change: update every consumer in the same commit.

Public `@vfox/core` surface (frozen; see `packages/core/src/index.ts`):

```ts
createCore({ dataDir, kernelDir?, logger? }): Promise<Core>

Core.profiles: list get create update remove clone
Core.groups:   list create rename remove
Core.runtime:  list get launch stop on('change', cb)
Core.kernel:   info install
Core.close()
```

Public `@vfox/server` surface (frozen; the desktop main process calls this in-process):

```ts
startServer(opts: {
  dataDir: string
  port?: number      // default DEFAULT_API_PORT (9000)
  host?: string      // default 127.0.0.1
  token?: string     // auto-generated and persisted at <dataDir>/api-token when omitted
  logger?: CoreLogger
}): Promise<ServerHandle>

interface ServerHandle {
  host: string
  port: number
  token: string
  url: string        // `http://<host>:<port>`
  close(): Promise<void>
}
```

## Development

The local machine runs under a workspace-write file sandbox, so every package/browser cache must stay
inside the checkout. **Source this before any node/pnpm/playwright/camoufox command:**

```powershell
. .\scripts\dev-env.ps1
```

It redirects `npm_config_cache`, the pnpm store, `ELECTRON_CACHE`, `PLAYWRIGHT_BROWSERS_PATH` and
`CAMOUFOX_INSTALL_DIR` into `./.cache/` (gitignored).

```powershell
pnpm install                 # install workspace deps
pnpm kernel:fetch            # download the Camoufox engine (~493 MB) + GeoIP DB (~64 MB)
pnpm build                   # build packages, then the desktop app
pnpm typecheck               # tsc -b across the workspace
pnpm test                    # vitest across the workspace
pnpm dev                     # run the desktop app against the local core
```

Verified on this machine: Node 24.14, pnpm 10.33, `camoufox-js` 0.12.0,
`playwright-core` **1.60.0** (camoufox-js peer range is `<1.61.0` — do not float it).

## Gotchas

- `camoufox-js` requires `playwright-core < 1.61.0`. Newer Playwright versions break the patched
  Juggler protocol. The version is pinned exactly for that reason.
- The Firefox engine has **no CDP endpoint**. Automation attaches with
  `firefox.connect(wsEndpoint)` from `playwright-core`, not `chromium.connectOverCDP`.
  The VirtualBrowser-compatible `/api/v1/launchBrowser` alias therefore returns `wsEndpoint` and
  leaves `debuggingPort` null rather than inventing a port.
- **Persistent profile + wsEndpoint are BOTH available, via one private playwright-core hook.**
  `firefox.launchServer({ ...opts, _userDataDir })` routes into `launchPersistentContext` and returns
  that context's browser wrapped in a `BrowserServer` (`coreBundle.js:52555-52586`), so a profile keeps
  its durable isolated directory **and** exposes `wsEndpoint()`, `process()` (the real browser pid) and
  `on('close', (exitCode, signal))`. Two private options are load-bearing and must be pinned:
  - `_userDataDir` — the durable per-profile directory. Without it `launchServer` uses a throwaway temp profile.
  - `_sharedBrowser: true` — the browser survives the last automation client disconnecting, so the
    user's window does not vanish when their script exits.
  The `-profile` guard in `firefox.defaultArgs` (`coreBundle.js:44190`) only throws when a *caller*
  injects `-profile` into `args`; Playwright owns that argument itself.
  Because both options are undocumented, `playwright-core` is pinned to an exact version and
  `packages/core` carries a guard test asserting the hook still exists — a silent Playwright bump must
  fail CI, not quietly degrade every profile to a temp directory.
- **`better-sqlite3` IS a real runtime dependency, and must be built.** `camoufox-js/dist/webgl/sample.js`
  imports it and that WebGL sampler runs on **every launch**, so removing it from
  `pnpm.onlyBuiltDependencies` in the root `package.json` breaks every profile launch. An earlier note
  here claimed it was never imported — that was wrong, and the mistake is instructive: it came from
  grepping the package's top-level `dist/*.js` for a static import and missing a nested one. Verify by
  loading the module (`node -e "require('better-sqlite3')"`), not by grepping.
- **No Vitest run is possible in the development sandbox *by default* — but a working recipe exists.**
  The four walls are: (1) tinypool's `forks` pool needs a piped `fork()`; (2) Vite's
  `windowsSafeRealPathSync` calls `exec("net use")`; (3) any `vitest.config.*` is bundled with esbuild,
  whose service spawn needs a pipe; (4) Vite transpiles `.ts` with esbuild, so TypeScript test files can
  never run locally. All four are beatable, and `packages/server`, `packages/cli` and `packages/sync`
  do it: a ~12-line preload that answers the `net use` probe locally, `--pool=threads` on the command
  line (no config file), and tests written as plain `.mjs` that import the built `dist/` while `src/`
  stays strict TypeScript. See `packages/server/test/{run-vitest.mjs,sandbox-preload.mjs}`. Otherwise
  fall back to `tsc` + `biome` + a throwaway harness over `dist`, or `node --test --test-isolation=none`.
  CI is unaffected either way.
- The Camoufox kernel is ~493 MB and is deliberately *not* committed and *not* bundled into the
  installer by default; it is fetched on first run (or pre-seeded in CI via the Actions cache).
- Electron's `app.getPath('userData')` is the default `dataDir`; the CLI and server default to
  `%APPDATA%/vfox` so all three share one profile store.
- **The Electron main process must be built as CJS.** With `"type": "module"` electron-vite emits the
  main process as ESM, and Electron's `electron` module is CommonJS with dynamically defined exports,
  so `import { BrowserWindow } from 'electron'` dies at startup with
  `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`.
  The build succeeds and every typecheck passes — only running the app reveals it. Keep main (and
  preload) on CJS output.
- **`noDefaultViewport: true`, never `viewport: null`.** `launchServer` validates against the
  *server-side* `BrowserTypeLaunchPersistentContextParams` scheme, whose only viewport field is
  `noDefaultViewport` (`coreBundle.js:20993`); the client-side `launchPersistentContext` is what
  accepts `viewport: null` and translates it (`coreBundle.js:57151`). Passing `viewport: null` throws
  `ValidationError: viewport: expected object, got null`.
- **A profile's identity must be generated once and re-injected.** Camoufox's generator is not
  reproducible across launches (upstream ROADMAP, issues #442/#765), and `camoufox-js` additionally
  re-rolls six config keys on *every* launch — `canvas:seed`, `audio:seed`, `fonts:spacing_seed`,
  `canvas:aaOffset`, `canvas:aaCapOffset`, `window.history.length` (`dist/utils.js:424-433`, `:531-534`).
  Pinning only `identity.fingerprint` is therefore not enough; those six are pinned through the raw
  `config` escape hatch, which wins over the engine's randoms. Without both, a profile is a different
  device every time it opens.
- **`adm-zip` 0.5.x silently exports an empty directory tree on Windows.** `addLocalFolderAsync2`
  runs the path through `fixPath`, a *zip-internal* normaliser, so an absolute Windows path no longer
  exists; the ENOENT branch resolves the promise with nothing added. Walk the directory with
  `fs.readdir(root, { recursive: true, withFileTypes: true })` and add files individually — that also
  pins the in-archive layout to forward slashes. Note `packages/core/node_modules/adm-zip` (0.5.x) and
  the hoisted root copy can differ, which makes this look fine in isolation.
- **`No Vitest run` was corrected above — ignore the older claim if you find it quoted elsewhere.**
  The sandbox blocks creating **any** child stdio slot set to `'pipe'`, and the ban is inherited by
  grandchildren, which is what breaks esbuild, Electron, Playwright and Chromium's own subprocess
  sandbox. Local UI screenshots are therefore impossible; the UI is verified in CI by
  `apps/desktop/scripts/screenshot-ui.mjs` (Playwright against the built renderer and the real server).
- **Reading a fingerprint value can be harder than spoofing it.** The engine smoke test reported
  `webglVendor: null` for both profiles until `engine` found the cause: a canvas element can only ever
  have **one** context type, and the probe asked the *same* element for `webgl` after creating a `2d`
  context. Use a separate element per context. After the fix the same runner reports
  `"Google Inc. (NVIDIA)"` / `"Intel Inc."` and `distinctCount` rose from 5 to 6. Before concluding a
  dimension is unspoofed, prove the probe can read it at all.
- **The engine re-rolls eight things on every launch**, so pinning only `identity.fingerprint` is not
  enough: seven `CAMOU_CONFIG` keys (`canvas:seed`, `audio:seed`, `fonts:spacing_seed`,
  `canvas:aaOffset`, `canvas:aaCapOffset`, `window.history.length`, `window.screenY` via
  `fingerprints.js:31-54`) **plus a fresh WebGL vendor/renderer sample** (`webgl/sample.js:62-75`).
  `packages/core` pins all eight — the WebGL pair through `fingerprint.webgl` → `webgl_config`, the rest
  through the raw `config` escape hatch.
- **`koffi` ships prebuilt binaries for every platform** (`build/koffi/win32_x64/koffi.node`), so it
  needs no build step — and adding it to `pnpm.onlyBuiltDependencies` makes its postinstall run and
  fail with `EPERM` in the sandbox for no benefit. Verified: `require('koffi').load('user32.dll')`.
- The smoke script imports `packages/core/dist`, so `pnpm --filter @vfox/core build` must run before
  it; it exits 2 with a `build-missing` stage rather than an ENOENT.
- **Portable mode.** Data resolution order: `VFOX_DATA_DIR` env → `portable` marker file or `data/`
  directory next to `process.execPath` → `app.getPath('userData')`. The portable zip ships the marker
  and an empty `data/`, and nothing may persist an absolute path that would break after the folder is
  moved.

## License

MIT for this repository's own code. Camoufox (MPL-2.0) and camoufox-js (MPL-2.0) are consumed as
external dependencies and are not modified; their binaries are downloaded at runtime, not vendored.
