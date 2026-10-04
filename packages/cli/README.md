# @vfox/cli

The `vfox` command line tool. Every command is a thin wrapper over `@vfox/core`; `serve` and `mcp`
delegate to `@vfox/server`, and `sync` drives a running server over HTTP (see below). It never
imports Electron, never spawns a browser of its own, and carries no telemetry, no update check and
no command framework — the argument parser is [`src/args.ts`](./src/args.ts).

```
vfox serve [--port 9000] [--host 127.0.0.1] [--token <t>]   # start the API service (foreground)
vfox list [--json]                                          # table of profiles + runtime status
vfox create <name> [--os windows|macos|linux] [--proxy url] [--group <g>]
vfox start <id|name> [--wait]                               # launch, print wsEndpoint
vfox stop <id|name>
vfox open <id|name>                                         # launch if needed (convenience)
vfox rm <id|name> [--yes]
vfox clone <id|name> [--name <new>]
vfox export <id|name> <file.zip>
vfox import <file.zip> [--name <new>]
vfox kernel install|info
vfox sync start <master> <slave>... | stop | status | tile <id|name>...
vfox mcp                                                    # MCP server over stdio
```

Global options: `--json` (machine-readable stdout), `--data-dir <path>`, `--help`.

## Behaviour

- **Exit codes.** `0` success, `1` runtime failure (unknown profile, refused confirmation), `2`
  usage error (unknown command, unknown flag, missing argument).
- **`<id|name>`** is accepted everywhere an id is expected: an exact profile id, or an exact
  case-insensitive profile name.
- **`--json`** prints the raw core object. Progress, warnings and errors always go to **stderr**, so
  `vfox list --json | jq` is safe.
- **No prompts except destructive ones.** `vfox rm` asks for confirmation on a terminal and refuses
  outright when stdin is not one — pass `--yes` in scripts instead of hanging on a prompt nobody can
  answer.
- **`--group`** takes a group id or name and creates the group on demand, which keeps the command
  set self-sufficient (there is no separate `vfox group` command).
- **`--proxy`** accepts `http://`, `https://` or `socks5://` with optional credentials, e.g.
  `socks5://user:pass@127.0.0.1:1080`. Ports default to 8080/443/1080.
- **`--wait`** resolves on the core's `change` event rather than polling.
- `vfox start` prints whatever `wsEndpoint` the core reports and says so explicitly when there is
  none; it never invents one.

## Export / import

`vfox export` and `vfox import` call `core.profiles.exportZip` / `core.profiles.importZip`. The CLI
deliberately contains **no zip code of its own**: the archive format is the core's business, so the
CLI, the HTTP API and the GUI all produce byte-identical archives instead of three drifting
variants. (`adm-zip` is therefore an unused dependency of this package and can be dropped from
`package.json`.)

## `vfox serve`

Starts the same service the desktop app runs in-process: REST under `/api/v1`, SSE at
`/api/v1/events`, MCP at `/mcp`. Without `--token` the token is read from `<data-dir>/api-token` and
generated there on first run. The port actually bound is printed — if 9000 is taken the server falls
back to an ephemeral port rather than failing.

## `vfox sync`

The window synchroniser: input performed once in a **master** profile is replayed into every
**slave** profile, and `tile` arranges their real OS windows.

```
vfox sync status                                  # is a session active?
vfox sync start <master> <slave> [<slave>...]     # ids or exact names
vfox sync stop
vfox sync tile <id|name>... [--layout grid|rows|columns] [--display <n>]
```

These commands are the **one exception** to "every command is a thin wrapper over `@vfox/core`":
the session belongs to the server process (`startServer` constructs it once and the GUI watches it
over SSE), so a session opened inside a short-lived CLI process would end the moment the command
exited. `vfox sync` therefore drives a server that is already running — `vfox serve`, or the
desktop app — over the same loopback API the renderer uses, and the server, not the CLI, resolves
profile names.

Connection: `--url` (default `VFOX_API_HOST`/`VFOX_API_PORT`, i.e. `http://127.0.0.1:9000`; pass the
port `vfox serve` printed if 9000 was taken) and `--token` (default `VFOX_API_TOKEN`, then
`<data-dir>/api-token`). The token is only ever **read**: a client that minted its own would write a
file that then fails every request, so a missing token is an error that names the file it looked in.

`status` exits `0` while a session is active and `1` when there is none, so it can gate a script;
`--json` prints the `SyncSession` (or `null`). A request the API rejects — an unknown profile, a
profile that is not running, `tiling_unavailable` — prints the server's own message on stderr and
exits `1`.

## `vfox mcp`

Speaks MCP on stdin/stdout so an MCP client can launch the command directly. Nothing but protocol
frames is ever written to stdout; all diagnostics go to stderr.

## Tests

```powershell
. .\scripts\dev-env.ps1
pnpm --filter @vfox/cli test
```

`test/cli.test.mjs` drives `main()` in-process against a **real** `@vfox/core` over a throwaway data
directory and asserts exit codes, JSON purity and the full create → list → clone → export → import →
remove round trip. `start`/`open` are not exercised locally: the development sandbox forbids the
piped stdio Playwright needs to launch a browser, so CI covers those.

`test/sync.test.mjs` drives `main()` against a **real** `@vfox/server` over a real loopback socket
(`test/helpers/fake-api.mjs`), stubbing only the browser and the synchroniser session. It covers the
full command surface, the exit codes, `--json` purity, and the messages for an unreachable API and a
missing token.

Tests are plain ESM against the built `dist/`, run through `test/run-vitest.mjs`. See
[`../server/README.md`](../server/README.md) for why that launcher exists.
