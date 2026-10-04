# @vfox/server

The VFox HTTP API: REST under `/api/v1`, server-sent events at `/api/v1/events`, and MCP over
Streamable HTTP at `/mcp`. It is started **in-process** by the Electron main process and by
`vfox serve`; it never imports Electron.

```ts
import { startServer } from '@vfox/server'

const handle = await startServer({ dataDir: app.getPath('userData') })
// handle.url   -> 'http://127.0.0.1:9000'   (the port actually bound)
// handle.token -> required in the `x-vfox-token` header
await handle.close() // stops the HTTP server *and* the core
```

`startServer` binds `DEFAULT_API_PORT` (9000) when no port is given. 9000 is commonly squatted
(Xdebug, PHP-FPM, Portainer, SonarQube, ClickHouse, MinIO), so a failed bind falls back to an
ephemeral port instead of crashing — always read the real port back from `ServerHandle.port` /
`.url`. An explicitly requested port that is taken is an error.

`close()` always shuts down both the HTTP server and the core.

## Data directory

`resolveDataDir()` implements the portable-mode rule from AGENTS.md:

1. an explicit `dataDir` (the desktop passes `app.getPath('userData')`),
2. `VFOX_DATA_DIR`,
3. **portable mode** — a `portable` marker file or a `data/` directory next to
   `process.execPath`, in which case everything lives in that `data/` directory so the folder can be
   moved between machines,
4. `%APPDATA%/vfox`, so the server, the CLI and a non-portable desktop build share one store.

Nothing persists an absolute path that would break after a portable folder is moved.

## Routes

Every route answers with the `ApiResult<T>` envelope from `@vfox/shared` — `{ success: true, data }`
or `{ success: false, error: { code, message, details? } }` — with one deliberate exception.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/health` | `Health` |
| GET | `/api/v1/profiles` | `Profile[]` |
| POST | `/api/v1/profiles` | `Profile` (201) |
| GET | `/api/v1/profiles/:id` | `Profile` |
| PATCH | `/api/v1/profiles/:id` | `Profile` |
| DELETE | `/api/v1/profiles/:id` | `{ id, removed }` |
| POST | `/api/v1/profiles/:id/launch` | `ProfileRuntime` (409 when already running) |
| POST | `/api/v1/profiles/:id/stop` | `ProfileRuntime` (idempotent) |
| POST | `/api/v1/profiles/:id/clone` | `Profile` (201) |
| GET | `/api/v1/profiles/:id/export` | **raw `application/zip` bytes** |
| POST | `/api/v1/profiles/import` | `Profile` (201) |
| GET | `/api/v1/runtime` | `ProfileRuntime[]` |
| GET | `/api/v1/runtime/:id` | `ProfileRuntime` |
| GET/POST | `/api/v1/groups` | `Group[]` / `Group` (201) |
| PATCH/DELETE | `/api/v1/groups/:id` | `Group` / `{ id, removed }` |
| GET | `/api/v1/kernel` | `KernelInfo` |
| POST | `/api/v1/kernel/install` | `{ started: true }` (202; 409 when already installing) |
| GET | `/api/v1/sync` | `SyncSession \| null` |
| POST | `/api/v1/sync/start` | `SyncSession` |
| POST | `/api/v1/sync/stop` | `{ ok: true }` |
| POST | `/api/v1/sync/tile` | `{ ok: true }` |
| GET | `/api/v1/events` | SSE stream |
| POST | `/api/v1/launchBrowser` | VirtualBrowser alias |
| POST | `/api/v1/closeBrowser` | VirtualBrowser alias |
| GET/POST | `/api/v1/browserList` | VirtualBrowser alias |
| POST/GET/DELETE | `/mcp` | MCP Streamable HTTP (JSON-RPC, not the envelope) |

`GET /profiles/:id/export` is the one route that does not use the envelope: it streams zip bytes
with a `Content-Disposition` filename, because a download has to be consumable by a browser or
`curl -O`. `POST /profiles/import` accepts raw zip bytes (`Content-Type: application/zip`) and an
optional `?name=<name>` query override.

Wherever the API takes an id it also accepts an exact profile name — that is what makes the
VirtualBrowser aliases usable from existing scripts.

### `wsEndpoint` and `debuggingPort`

`debuggingPort` is **always `null`**, in both the native routes and the aliases. The engine is
patched Firefox speaking Playwright's Juggler protocol: it has no Chrome DevTools Protocol
endpoint, so there is no port to report. Inventing one would make every script fail at connect
time. Attach with `firefox.connect(wsEndpoint)` from `playwright-core`.

`ProfileRuntime.wsEndpoint` is passed through from the core **verbatim** and is never synthesized
here; it is `null` whenever the launch mode exposes no automation endpoint.

## Kernel install

`POST /kernel/install` returns immediately — a ~493 MB download must never sit inside an HTTP
response. Progress is pushed on the `kernel` SSE event as `KernelProgress`; `phase: 'done'` is the
completion signal and `phase: 'error'` carries the failure message. Only one install may be in
flight (409 otherwise).

## Window synchroniser

`POST /sync/start` starts a session in which input performed in a **master** profile is replayed
into every **slave** profile; `GET /sync` answers the current session or `null`, and `POST
/sync/stop` ends it. `POST /sync/tile` arranges the given profiles' real OS windows in a grid, rows
or columns. The work itself lives in `@vfox/sync` — this layer only translates HTTP.

- **One handle per process.** `startServer` constructs `createSync()` exactly once, with a `resolve`
  that reads the core's runtime registry (`wsEndpoint` + pid). Every route shares that handle, so
  there is exactly one session and one set of browser attachments. It is imported lazily, like
  `@vfox/core`: importing this package must not require `@vfox/sync` to be built, and the tests
  inject a fake handle instead.
- **`resolve` decides "unknown" from `runtime.list()`, not `runtime.get()`.** The registry answers
  a synthetic `stopped` runtime for an id the store does not know, so `get()` cannot tell an unknown
  profile (404) from a stopped one (409).
- **An id or an exact profile name** is accepted everywhere, as on every other route; only the id
  the profile store supplied is handed to the synchroniser.
- **Failures carry the synchroniser's own code**, so a client can branch on one vocabulary:

  | `SyncError.code` | HTTP |
  | --- | --- |
  | `invalid_input` | 400 |
  | `unknown_profile` | 404 |
  | `not_running`, `already_active` | 409 |
  | `tiling_unavailable` | 501 |
  | `attach_failed` | 502 (the browser behind the profile's `wsEndpoint` could not be reached) |
  | `closed` | 503 (the synchroniser was shut down — a request racing server shutdown) |

  A malformed body is still the API's own `validation_error` / 400. `stop` is idempotent, and
  `tile` needs at least one profile whose window actually exists: tiling is Windows-only and the
  engine's invisible helper windows are never matched, so "no visible window" is a 501 with that
  message rather than a silent no-op.

## Events

`GET /api/v1/events` is the only way runtime state reaches a client. There is **no polling**: the
hub subscribes once to `core.runtime.on('change')`, `core.kernel.on('progress')` and
`sync.on('change')` and fans frames out. On connect it replays a snapshot (current runtimes, the
last kernel phase, and an active sync session), so a late client is immediately consistent. The one
timer it owns writes a comment-only `: ping` keepalive, which carries no state and never reads the
core.

A sync frame is a `SyncSession`, and `null` is a real transition — it is what a UI clears its state
on. A session that has already stopped is deliberately *not* replayed; `GET /sync` answers the
current state for anything older.

## Security

The API binds loopback and requires a token, and those two facts are the boundary. On top of them:

- **`Host` allowlist.** A request whose `Host` is not `127.0.0.1`, `localhost` or `::1` is rejected
  with `403 forbidden_host`, and when the socket knows its own port the header's port must match.
  This — not CORS — is the DNS-rebinding defence: an attacker's page is same-origin with the
  rebound name, so only the `Host` header gives it away.
- **CORS for the renderer.** The GUI is a browser context (`file://` in production, a dev server in
  development), so every call is cross-origin and `x-vfox-token` is not safelisted: Chromium sends
  a preflight `OPTIONS`, which never carries the token. Preflights are therefore answered **before**
  the token check with 204 and `access-control-allow-origin`. The origin is reflected only for
  `null` and loopback origins; any other origin gets no CORS headers at all (the request is still
  served — the browser blocks the read, which is the correct outcome). No wildcard, no
  `@fastify/cors` dependency.
- **Content type on writes.** Any `POST`/`PATCH`/`PUT`/`DELETE` that carries a body must use
  `application/json`, or `application/zip` on the import route, and gets `415` otherwise. A
  cross-site HTML form cannot set either, so that attack class never reaches a handler.
- **No client-supplied filesystem paths.** Zip staging happens under `<dataDir>/tmp` with
  server-generated names. A raw path segment is only ever handed to the core as an id when it
  matches `/^[A-Za-z0-9._-]{1,128}$/`; anything else is treated as a profile *name* and can only
  match a profile the store already knows about, so the id used downstream always comes from the
  store rather than from the client.
- `Authorization: Bearer <same token>` is accepted as an alias for `x-vfox-token`, because that is
  the header stock MCP clients send. Same token, same constant-time comparison.

## MCP

`/mcp` speaks MCP over Streamable HTTP in **stateless** mode (a fresh transport per request, per the
SDK's requirement) and shares the same core instance and the same token as the REST API. Tools:
`list_profiles`, `create_profile`, `launch_profile`, `stop_profile`, `get_runtime`, `clone_profile`,
`delete_profile`. `serveMcpStdio(core)` exposes the identical tool set over stdio for `vfox mcp`.

## Diagnostics

`startServer` always writes a rotating log to `<dataDir>/logs/vfox.log` (5 files × 2 MB). It records
the bound URL, the token's *presence* and source — never its value — lifecycle events, and every
rejected request as `METHOD /path -> status`. The desktop app's "copy diagnostics" action reads it.

## Tests

```powershell
. .\scripts\dev-env.ps1
pnpm --filter @vfox/server test
```

Tests live in `test/` as plain ESM and drive a real Fastify app with `app.inject()` against a fake
`Core` **and** a fake `SyncHandle`, plus one suite over a real loopback socket. They import the built
`dist/`, so the script builds first.

No test launches a browser, so the sync routes are covered from both sides: `test/sync.test.mjs`
drives every status, every `SyncError` code mapping and every SSE frame through the fake handle, and
then runs the **real** `createSync()` handle (through `startServer`, over a real socket) for the
cases that fail before Playwright is touched — an unknown profile, a profile that is not running, a
master that is also a slave, and a tile request whose pid matches no window. Actually attaching to a
live browser, and therefore real master→slave mirroring over HTTP, is only provable in CI
(`e2e-engine` runs `packages/sync/scripts/smoke-sync.mjs` against two real windows).

Two environment notes, both handled by `test/run-vitest.mjs` and `test/sandbox-preload.mjs`:

- This machine's file sandbox denies piped stdio, so Vitest's default `pool: 'forks'` cannot start.
  The scripts pass `--pool=threads`.
- Vite's Windows path bootstrap runs `net use` through `child_process.exec`, which needs a pipe.
  The preload answers that one probe locally and forwards every other `exec` call unchanged.
- Vitest transpiles TypeScript with esbuild, which spawns its service binary over pipes — also
  denied. Test files are therefore plain `.mjs` against `dist/`; `src/` stays strict TypeScript and
  is type-checked by `pnpm --filter @vfox/server typecheck`.

Real profile launches are verified in CI, never here.
