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
- `better-sqlite3` appears in `camoufox-js`'s dependency list but is **never imported by its build
  output**. Ignore the pnpm "ignored build scripts" warning; do not add native build steps for it.
- The Camoufox kernel is ~493 MB and is deliberately *not* committed and *not* bundled into the
  installer by default; it is fetched on first run (or pre-seeded in CI via the Actions cache).
- Electron's `app.getPath('userData')` is the default `dataDir`; the CLI and server default to
  `%APPDATA%/vfox` so all three share one profile store.

## License

MIT for this repository's own code. Camoufox (MPL-2.0) and camoufox-js (MPL-2.0) are consumed as
external dependencies and are not modified; their binaries are downloaded at runtime, not vendored.
