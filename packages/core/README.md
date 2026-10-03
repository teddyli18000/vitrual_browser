# @vfox/core

Profile store, fingerprint identity, Camoufox launcher and runtime registry — the layer between the
frozen domain contract (`@vfox/shared`) and everything that drives it (server, CLI, desktop).

`src/index.ts` is the **frozen public surface**; nothing else in this package is public API.
`src/index.ts` holds the interfaces and delegates to `src/core.ts`.

## Source map

| File | Responsibility |
| --- | --- |
| `core.ts` | wiring: store + identity + registry + kernel + log behind the `Core` surface |
| `store.ts` | plain-JSON persistence, atomic writes, backup/recovery, profile directories |
| `identity.ts` | the profile's device identity: generated once, re-injected on every launch |
| `fingerprint.ts` | `FingerprintConfig` → camoufox-js launch options (pure, no I/O) |
| `launcher.ts` | `firefox.launchServer()` options, one visible window per profile, process-tree kill |
| `runtime.ts` | runtime states, `change` events, unexpected-exit detection (no polling timers) |
| `archive.ts` | portable profile zip (`exportZip` / `importZip`) |
| `kernel.ts` | engine discovery, installation, real byte-level progress |
| `orphans.ts` | startup reconciliation of engine processes left by a previous run |
| `log.ts` | rotating file log at `<dataDir>/logs/vfox.log` |

## On-disk layout

```
<dataDir>/profiles.json                     Profile[] — the whole profile table
<dataDir>/profiles.json.bak                 the previous generation
<dataDir>/profiles.corrupt-<ts>.json        a quarantined corrupt file, kept as evidence
<dataDir>/groups.json                       Group[]
<dataDir>/profiles/<id>/userdata/           the profile's real, isolated browser data directory
<dataDir>/logs/vfox.log                     rotating diagnostics log (5 × 2 MB)
```

Nothing is stored in a database, so a profile can be copied, zipped, diffed and backed up with
ordinary tools.

## Invariants worth knowing before you change anything

- **A profile is the same device every time it is opened.** The identity is generated once at
  creation and stored in `profile.identity`; the launcher passes it back verbatim. See
  `src/identity.ts` — including why the browserforge fingerprint alone is not enough (camoufox-js
  re-rolls six CAMOU_CONFIG keys per launch, which are pinned through the raw `config` escape hatch).
  Editing `os`, `screen` or `window` drops the identity so it is re-rolled exactly once.
- **Writes are atomic and recoverable.** Temp file → `.bak` of the previous generation → rename,
  with up to 10 retries because Windows `MoveFileEx` fails while antivirus, the search indexer or a
  sync client holds a handle. A file that fails validation is quarantined and the `.bak` is restored
  loudly; with no usable backup, loading **fails** rather than starting from an empty store.
- **Stopping a profile kills the whole process tree** (`taskkill /PID <pid> /T /F` after Playwright's
  graceful Juggler close), and a relaunch of a profile that was killed abnormally is unblocked by
  `orphans.ts`. Profile directories are never deleted by reconciliation — only stale `parent.lock`
  files.
- **No polling.** Every runtime transition is driven by a real event (the launch promise, the
  browser process exit, the install stream).
- **Two undocumented playwright-core options are load-bearing**: `_userDataDir` (the durable
  per-profile directory) and `_sharedBrowser` (the window survives an automation client
  disconnecting). `playwright-core` is pinned to an exact version and
  `test/launcher.guard.test.ts` fails CI if either hook disappears. Read the header of
  `src/launcher.ts` before touching the option list.

## Commands

```powershell
. .\scripts\dev-env.ps1            # redirects every cache into the repo (required in the sandbox)
pnpm --filter @vfox/core build     # tsc -b (also builds @vfox/shared)
pnpm --filter @vfox/core typecheck # tsc -b + tsconfig.test.json (src and tests)
pnpm --filter @vfox/core test      # vitest
pnpm exec biome check packages/core
node packages/core/scripts/smoke-launch.mjs   # real engine smoke test — CI only, see below
```

## Known limitations (v0.1.0)

- **Exports are built in memory** (adm-zip has no streaming writer). `exportZip` refuses a data
  directory larger than 2 GB with an actionable error instead of exhausting the process. Excluding
  the browser cache from archives is the obvious follow-up.
- **Engine installation is not resumable and not checksum-verified.** It downloads to a staging file,
  extracts, then replaces the previous engine, so a failed download never leaves the user without an
  engine; a failed *extract* requires a retry. Free space is checked (3 GB) before starting.
- **`fingerprint.deviceMemory` is not supported by the engine** (Firefox has no
  `navigator.deviceMemory`) and is ignored with a warning.
- **Process-tree kill is Windows-only.** On other platforms Playwright's own close path is used.
- **The smoke test cannot run in the development sandbox** (it cannot create a child process with
  piped stdio, which the engine requires). It is a CI gate; run it in CI or any unconfined shell, and
  remember it imports `dist`, so build first.
- **A local `pnpm test` run of this package is best-effort; CI is authoritative.** The suite needs
  Vitest's default `forks` pool (one process per file). Inside the sandbox that pool is impossible —
  a `fork()` over piped stdio is denied — so `test/run-vitest.mjs` falls back to `threads`. That
  fallback works, but `camoufox-js/dist/utils.js` imports `./ip.js`, which loads the native `impit`
  addon at module load and keeps clients in a module-level Map, and a worker thread does not always
  survive its teardown. Measured: importing `impit` alone and doing nothing else crashed 4 of 6 runs
  with `0xC0000005`, and a full suite run dies that way roughly half the time **after every test has
  passed**. CI runs the forks pool and is unaffected.
- **`ProfileUpdateSchema` cannot express a partial `fingerprint`/`launch` patch.** `zod`'s
  `.partial()` keeps the inner `.default()`s, so `{ fingerprint: { hardwareConcurrency: 4 } }` parses
  into a *complete* fingerprint with `os: 'windows'`. `Store.updateProfile` therefore merges the raw
  keys the caller sent rather than the parsed value — but a caller that validates a request body with
  `ProfileUpdateSchema` first (the server does) has already lost that distinction, so editing one
  field through the API can reset the rest of the fingerprint. Fixing it properly is a
  `packages/shared` change.
