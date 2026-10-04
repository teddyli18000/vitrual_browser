# @vfox/cli

The `vfox` command line tool. Every command is a thin wrapper over `@vfox/core`; `serve` and `mcp`
delegate to `@vfox/server`. It never imports Electron, never spawns a browser of its own, and
carries no telemetry, no update check and no command framework — the argument parser is
[`src/args.ts`](./src/args.ts).

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
variants.

## Cookies — moving a logged-in session

```
vfox cookies export <id|name> --out <file>     # write a Netscape cookies.txt
vfox cookies import <id|name> --in <file>      # merge one in
vfox cookies import <id|name> --in <file> --replace
```

The account-moving workflow: register in profile A, move the session to profile B — or back it up,
or duplicate it — without copying the whole profile directory.

- The file is **Netscape `cookies.txt`**, the format curl, wget, yt-dlp and the other anti-detect
  browsers read and write, so the session stays usable outside VFox too.
- **The profile must be stopped.** Both directions read and write the profile's own
  `cookies.sqlite`; nothing is launched, so exporting fifty profiles costs fifty file reads. A
  running profile is refused rather than silently skipped.
- **`import` merges by default**, upserting on host + name + path and leaving every other cookie
  alone. **`--replace` empties the jar first**, so the profile ends up with exactly the file.
- A profile that has never been launched has no cookie store yet: `export` writes a valid empty file
  and says so, and `import` refuses with "launch it once" rather than fabricating a Firefox
  database.
- Unusable lines are reported with their line number and reason; an import only fails outright when
  *nothing* in the file could be read.
- SameSite is not part of the format, so imported cookies land as "unspecified" (Firefox treats that
  as Lax). Container and partitioned cookies cannot be represented and are reported as skipped. The
  full table is in [`../core/README.md`](../core/README.md).

## `vfox serve`

Starts the same service the desktop app runs in-process: REST under `/api/v1`, SSE at
`/api/v1/events`, MCP at `/mcp`. Without `--token` the token is read from `<data-dir>/api-token` and
generated there on first run. The port actually bound is printed — if 9000 is taken the server falls
back to an ephemeral port rather than failing.

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

Tests are plain ESM against the built `dist/`, run through `test/run-vitest.mjs`. See
[`../server/README.md`](../server/README.md) for why that launcher exists.
