# AGENTS.md — VFox

Agent-facing operational memory: **the rules this project is built and delivered under, and the traps
that cost us defects.** Product documentation belongs in `README.md` and `docs/`.

Keep it updated as discoveries land, not batched at the end of a task. Before adding a line: is this a
rule, a trap, or neither? If neither, it does not go here.

---

## 1. Product rules

- **Zero telemetry.** The product may make exactly three outbound calls: the engine download on first
  run, the user's own configured proxy, and the GeoIP lookup when `fingerprint.geoip` is enabled. A new
  outbound call needs a `README.md` entry and a justification in the PR.
- **Nothing paid, nothing promoted, no cloud.** No licence check, no tier, no referral links, no ads, no
  service of ours, no accounts. Backup is per-profile export/import to a local zip. If a task seems to
  need a remote endpoint or a payment surface, stop and ask.
- **Real windows.** `launch.headless` defaults to `false` and must never become the default; headless
  exists only for CI and automation.
- **Lightweight by construction.** One Electron window, one Node core process, no sidecars or helper
  daemons. **No polling** — runtime state is pushed over SSE (`/api/v1/events`) from process events. No
  auto-updater, no crash reporter, no devtools in production builds. Profiles launch on demand and die
  with their whole process tree. Storage is plain JSON plus directories — **no database, no native
  modules** — so a profile can be copied, zipped and diffed with ordinary tools. UI dependency budget:
  Vue 3 + Vite + Element Plus + Pinia, nothing else without justification.
- **Portable.** All data lives in the product's own folder and the folder can be moved as a whole;
  nothing may persist an absolute path.
- **File management - where our bytes may land.** The owner's rule, and it is absolute:
  **installed**: no litter outside the product's own data directory - no temp files in %TEMP%, no
  caches in the user profile, no logs scattered anywhere. **portable**: **everything we produce stays
  inside the portable folder** - every byte we write, including engine downloads, browser profiles,
  cookie databases, caches and logs, must be inside it, and writing anywhere else is a defect.
  **portable independence**: the folder copied to any location must work - nothing persists an absolute
  path, nothing lives in the registry, no machine state outside the folder. A feature that writes outside
  the boundary is wrong even if it works, because it breaks the promise that the folder is the product.
- **No secrets in the repo.** Proxy credentials live in the user's local profile store only.
- **Window sizing is a ratio of the real work area**, with the ceiling relative to that work area. An
  absolute pixel ceiling is a bug: it becomes a small window on a large display.
- **Nothing installs on the owner's machine.** Risky builds and tests run on GitHub Actions, never
  locally; CI quota is not a constraint.

## 2. Delivery discipline

1. A behaviour change starts as an issue. A non-trivial design is written down and reviewed **before**
   the code exists.
2. One concern per PR. The author never reviews their own work.
3. Every PR is reviewed by someone who did not write it, reporting **what was verified** (with raw
   output), **what was not verified**, and **what is still believed wrong**, ranked by user impact. A
   review that only agrees is not a review.
4. **The Lead merges, never the author**, and re-runs the gate on the same commit instead of trusting a
   summary — a summary is a claim, and claims are what reviews are for.
5. **Every assertion ships with the output of it going red.** A guard that has never failed has not been
   shown to test anything; a guard that scans zero inputs and returns green is worse than none, because
   it is believed. This repository has shipped that mistake twice.
6. **Verify the artifact that ships, not the directory that was built.** v0.3.4 passed every check
   against `release/win-unpacked` and failed every install on the owner's machine, because that directory
   let module resolution walk up into this repository's own `node_modules`. *Current state: `ci.yml` and
   `release.yml` still run the packaged suite against `release/win-unpacked`; the zip and installer are
   built, hashed and published without ever being extracted and run. Closing that is task-17 — until it
   lands, this rule is a target, not a fact.*
7. Releases are cut from a green `main`, one at a time, never batched.
8. Before pushing a branch assembled from the shared working tree, check **both** directions:
   ```powershell
   git diff --stat origin/main                 # every hunk must belong to this task
   git diff origin/main | Select-String '^-'   # nothing that is on main may disappear
   ```
   The shared tree drifts behind `main` within hours. Work in a worktree from `origin/main` and treat any
   file copied out of the shared tree as suspect until that diff is clean. Both failure modes happened on
   the same day: one assembly reverted work already on main, another added a file from a different branch.

## 3. How we test

- **CI is the primary evidence.** No browser can start in this sandbox, Electron cannot run, and the
  renderer cannot be built — so a browser-driven or packaged claim that has not run in CI has not been
  verified. Never present a partial local run as verification.
- **Test wide, and read the results.** Many sites per run, driven by Playwright in Actions: the
  dedicated fingerprint checkers *and* ordinary public sites. The dedicated checkers' verdicts must be
  brought back and read — code alone cannot tell you whether the fingerprint holds together. A blocked or
  unreadable result is reported as such and never counted as a pass.
- **Assert properties, not thresholds.** The packaged suite used to require "at least 4 of 11 dimensions
  differ" — a threshold that passed by luck, intermittently, on two runs of the same code twenty minutes
  apart. It now asserts that **no two profiles report the same WebGL vendor and renderer**. The worker
  comparison went the same way: "4 of 6" was flattering, "4 of 4" is honest.
- **A checker's own page is not a verdict.** Anti-detect sites contain the words "automated", "blocked"
  and "bot check" about themselves; a marker is only a verdict when the page corroborates it, and a miss
  is `UNREAD`, never a pass.

## 4. Traps

### Engine and fingerprint

- **Pin `playwright-core` to exactly 1.60.0** (`camoufox-js` peer range is `<1.61.0`); newer versions
  break the patched Juggler protocol.
- **A persistent profile and `wsEndpoint` are both available** through the private path
  `firefox.launchServer({ ...opts, _userDataDir })` (`coreBundle.js:52555-52586`). `_userDataDir`
  (otherwise a temp profile) and `_sharedBrowser: true` (the browser must survive the last client
  disconnecting) are load-bearing. A guard test asserts the hook still exists, so a silent Playwright
  bump fails CI instead of downgrading every profile to a temp directory.
- **`better-sqlite3` is a real runtime dependency and must be built** — `camoufox-js/dist/webgl/sample.js`
  imports it and that sampler runs on every launch. Judge dependencies by loading them
  (`require('better-sqlite3')`), never by grepping: a static-import search over the top-level `dist/*.js`
  misses a nested one.
- **The engine re-rolls eight things per launch**, so pinning `identity.fingerprint` is not enough: seven
  `CAMOU_CONFIG` keys (`canvas:seed`, `audio:seed`, `fonts:spacing_seed`, `canvas:aaOffset`,
  `canvas:aaCapOffset`, `window.history.length`, `window.screenY`) plus a fresh WebGL sample.
- **CAMOU_CONFIG travels in `env` as chunked variables** (`CAMOU_CONFIG_<n>`, 2047 chars each), not in
  `options.config` — reading `options.config` shows nothing.
- **`_castToProperties` drops falsy values** (`fingerprints.js:13`), so a stored `innerWidth: 0` never
  reaches the engine.
- **The WebGL sampler is weighted by real GPU market share**, and `webgl_data.db`'s `win`/`mac`/`lin`
  columns are float weights, not flags. Measured over 2000 draws: 15 of 32 pairs ever appear, the top
  three cover 81%, one GTX 980 row is 45%, and three profiles collided 61.3% of the time. Do **not** fix
  it by flattening the weights — the real distribution is itself a fingerprint. Draw from the engine's own
  table but only over pairs no other profile holds, and carry the whole batch's set (`createBatch`), or a
  batch collides with itself. **Re-drawing is not a fix**: with the popular pairs taken, what remains is
  rare. Select from the table, do not re-roll.
- **Reading a fingerprint value can be harder than spoofing it.** `webglVendor: null` came from a probe
  asking one canvas element for `webgl` after creating a `2d` context on it — a canvas has exactly one
  context type. One element per context. Before concluding a dimension is unspoofed, prove the probe can
  read it at all.
- **Reading the WebGL table from the app is fine**: `node:sqlite` with `readOnly: true`, through
  `camoufoxModule()`, which already handles the `app.asar.unpacked` redirect.
- **The smoke script imports `packages/core/dist`**, so `pnpm --filter @vfox/core build` must run first;
  it exits 2 with a `build-missing` stage rather than an ENOENT.
- **An addon's unit is an extracted directory, never an `.xpi`.** `camoufox-js` requires every path in
  `addons` to be an existing directory containing `manifest.json` (`dist/addons.js` `confirmPaths`
  otherwise throws `InvalidAddonPath`), and `addons` is a key the engine's own `properties.json`
  declares. Extract an `.xpi` at install time (adm-zip is already a dependency); store the directory.
- **`addons` is an *input* to camoufox-js, not a return value.** It assigns `config.addons` itself
  (`dist/utils.js:384-390`), so writing `options.addons` after `launchOptions()` returns reaches nothing
  — the addon never gets into `CAMOU_CONFIG` and only the engine's own default loads; the raw `config`
  escape hatch is overwritten too. It also **pushes the default addons into the array it was given**, so
  every launch and every retry needs a fresh array or the defaults accumulate. Assert on the `addons`
  inside `CAMOU_CONFIG`, never on the option object.
- **Addon paths must be absolute.** A relative path produces no error at all: the browser starts and the
  addon simply never loads (camoufox#399).
- **Addons live in the profile's own directory** (`<userdata>/vfox-addons/<slug>/`), so they exist for
  that profile's launches, are invisible to other profiles, and travel with `clone` / `export` /
  `import`. Do **not** put them in `<userdata>/extensions/`: that is Firefox's own sideload directory,
  where one gecko id would be loaded twice — once by the engine's `addons` option and once by Firefox's
  XPIProvider.
- **A profile zip is executable content.** Addons sit inside the profile directory, so importing someone
  else's profile imports their extensions and the engine loads them. That is a consequence of the
  layout, written down here so nobody has to learn it from an incident.

### Sandbox

- Source `. .\scripts\dev-env.ps1` before any node/pnpm/playwright/camoufox command (it redirects the
  caches into `./.cache/`).
- **The sandbox forbids setting any child stdio slot to `'pipe'`, and the ban is inherited by
  grandchildren.** That is what breaks esbuild, Electron, Playwright and Chromium's own subprocess
  sandbox. Chromium started with `stdio: 'ignore'` and driven over CDP still dies with
  `FATAL:mojo\public\cpp\platform\platform_channel.cc:112`, because Mojo's platform channel is a named
  pipe. Local UI screenshots and local packaged runs are impossible.
- **A working local vitest recipe exists**: a ~12-line preload that answers the `net use` probe,
  `--pool=threads` on the command line (no config file), and tests written as `.mjs` importing the built
  `dist/`. See `packages/server/test/{run-vitest.mjs,sandbox-preload.mjs}`. Otherwise fall back to `tsc` +
  `biome` + a throwaway harness over `dist`.
- **The engine never finishes starting here.** Spawning `camoufox.exe` directly (`stdio: 'ignore'` does
  start the process) leaves a fresh `-profile` directory **empty** after 22 s: no `prefs.js`, no
  `extensions.json`, while the process stays alive (~2 s CPU, 39 threads), stderr is clean and `MOZ_LOG`
  writes not one byte. Every variant behaves the same — `-headless`, no flags, `-foreground`,
  `-wait-for-browser`, and CI's argv minus `-juggler-pipe` — as does pointing `APPDATA`/`LOCALAPPDATA`
  into the workspace and disabling the crash reporter and the three subprocess sandboxes. **Anything that
  needs a real launch can only be concluded in CI**; locally only on-disk state and the option object are
  provable.
- **A test that reads the machine is a coin flip.** The CLI suite passed locally and failed in CI because
  `vfox addons list` includes the engine's read-only default when an engine is installed and prints
  `(none)` when none is: same code, two environments, two outputs. Pin `CAMOUFOX_INSTALL_DIR` at an empty
  directory (or a fixture engine directory) inside the case, and assert the empty state *and* the table
  shape in cases the test creates itself.

### Packaging and release

- **A step that must happen for the packaged app to work belongs in `electron.vite.config.ts`**, not on a
  package script: `scripts/build-installer.mjs` runs `electron-vite build` directly and never calls
  `apps/desktop`'s `build` script, so a chained command silently does not run in CI or a release. This is
  what made v0.3.0 fail every install with `Cannot find module …\out\main\unzip-worker.js`.
- **The root `package.json` must not declare `"type": "module"`.** electron-builder extracts helper tools
  into `<repo>/.cache/electron-builder/`, so a root ESM field makes Node parse those CommonJS files as ESM
  and packaging dies with `ReferenceError: require is not defined in ES module scope`. Every script here is
  `.mjs`, so the field buys nothing.
- **`electron` must be pinned exactly** — electron-builder refuses a range (it downloads platform
  binaries), and with `node-linker=hoisted` there is no `apps/desktop/node_modules/electron` to resolve
  from.
- **The Electron main process must be built as CJS.** With `"type": "module"` electron-vite emits ESM and
  Electron's `electron` module is CommonJS with dynamic exports, so startup dies with
  `SyntaxError: … does not provide an export named 'BrowserWindow'`. Build and typecheck both pass; only
  running the app reveals it.
- **`noDefaultViewport: true`, never `viewport: null`** — `launchServer` validates the server-side schema,
  whose only viewport field is `noDefaultViewport` (`coreBundle.js:20993`).
- **`adm-zip` 0.5.x silently exports an empty directory tree on Windows** (`addLocalFolderAsync2` runs the
  path through a zip-internal normaliser, so an absolute Windows path no longer exists). Walk with
  `fs.readdir(root, { recursive: true, withFileTypes: true })` and add files individually.
- **The engine is ~493 MB and is deliberately not committed and not bundled**; it downloads on first run.
- **`koffi` ships prebuilt binaries**, so it needs no build step; adding it to
  `pnpm.onlyBuiltDependencies` only makes its postinstall fail with EPERM in the sandbox.
- **The store's atomic write can fail with EPERM on Windows** (a temp file renamed over a target another
  handle holds). It already retries 10 times over ~200 ms and can still fail — see issue #74.
- `apps/desktop/e2e/lib/artifact.mjs` is the one guard in this repository **known to discriminate**: it
  fails on the real shipped v0.2.0 artifact and passes on a synthetic correct layout. It is the standard
  other guards are held to.
