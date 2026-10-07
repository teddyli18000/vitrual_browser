# Multiple engine kernels with per-profile pinning — design proposal

Issue #13 / task-21. **Proposal for review — no code written yet.**
Scope when approved: `packages/{shared,core,server,cli}` and `apps/desktop`.

The problem in one line: a profile's fingerprint is a function of the engine build it was created
with, so installing a new kernel must never change what an existing profile reports.

---

## 1. What the code actually does today (read, not assumed)

| Fact | Where |
| --- | --- |
| One engine directory, `CAMOUFOX_INSTALL_DIR`, **resolved once at module load** | `camoufox-js/dist/pkgman.js:44-45` |
| A profile already records the engine its identity was generated against — nullable, and the only engine fact stored today | `packages/shared/src/schemas.ts:102-110` (`identity.engine`) |
| `KernelInfo` = `{ installed, version, path, source }`; `source: 'bundled'` is never produced | `schemas.ts:188-193` |
| The launcher never passes an executable path; the engine comes from `launchPath()` → `INSTALL_DIR` | `packages/core/src/launcher.ts:80-122` |
| **`launchOptions()` takes a public `executable_path`** and only falls back to `launchPath()` when it is absent | `camoufox-js/dist/utils.d.ts`, `utils.js:342,552-559` |
| GeoIP database path and addon paths are derived from `INSTALL_DIR` at module load / per call | `dist/locale.js:132`, `dist/addons.js:48` |

**The trap that decides the layout.** Every launch calls
`launchOptions → addDefaultAddons → maybeDownloadAddons → getAddonPath → getPath → camoufoxPath()`
(`utils.js:385`, `addons.js:47-60`), and `camoufoxPath()` reaches
`new CamoufoxFetcher().install()` whenever the root directory is missing or empty, or holds a
`version.json` outside the supported range (`pkgman.js:300-321`). Measured on this machine with the
network stubbed out (raw output in §1.1): a kernel root that does not exist turns one
`launchOptions()` call into **10 outbound requests** — camoufox's own release lookup *and* a
separate download of uBlock Origin from `addons.mozilla.org`, each retried five times. That is the
fourth and fifth outbound call the product rules forbid, triggered by a launch that the user
believes is offline. Any layout has to keep the root looking installed.

The three distinct behaviours, measured rather than inferred:

| State of `<kernelRoot>` | What `camoufoxPath()` does |
| --- | --- |
| missing, or exists but empty | `CamoufoxFetcher.install()` → engine lookup + addon download (10 fetches measured) |
| non-empty, no `version.json` | `Version.fromPath` throws → the launch fails with `Version information not found at <root>/version.json. Please run \`camoufox fetch\` to install.` (no network) |
| non-empty, `version.json` present and supported | returns the root, no network (0 fetches measured) |

**A kernel must be a complete build, not just an executable.** `loadProperties()` resolves
`properties.json` **next to the executable** when one is passed, and from `INSTALL_DIR` otherwise
(`utils.js:60-71`). So the pinned kernel directory supplies the property table the launch config is
validated against — which is exactly the per-kernel behaviour this feature wants, and a second reason
a kernel directory is the unit of pinning rather than a path to an `.exe`.

**And the good news:** pinning needs no monkey-patching of the frozen `INSTALL_DIR`. Passing
`executable_path: <kernel>/camoufox.exe` per launch is a supported parameter, and the engine finds
its own resources relative to that executable.

### 1.1 Measured (probe run against the installed `camoufox-js`, network stubbed to count calls)

```
# getPath('addons/UBO') with a root that has version.json, fetches 0:
{ "mode": "marked", "rootExists": true, "fetches": 0,
  "getPathAddons": "…\\vfox-getpath-1zafRM\\addons\\UBO", "resolvedFromRoot": true }

# getPath('addons/UBO') with a root that does not exist:
{ "mode": "missing", "rootExists": false, "fetches": 1, "fetchesAfterWait": 1 }
# …and in the full launchOptions run, 10 fetches, with the trace:
#   camoufoxPath (pkgman.js:318) → CamoufoxFetcher.install → init → fetchLatest → getAsset → fetch
#   addDefaultAddons (addons.js:35) → maybeDownloadAddons → downloadAndExtract → webdl → fetch
#   "Failed to download from https://addons.mozilla.org/…/ublock-origin/latest.xpi after 5 attempts"

# launchOptions({ executable_path: <root>/kernels/152.0.4-beta.30/camoufox.exe }) with a marked root:
#   fetches 0, and the failure came from the PINNED directory, not the root:
#   ENOENT: … open '…\\kernels\\152.0.4-beta.30\\properties.json'
```

---

## 2. Layout

```
<kernelRoot>/                     = CAMOUFOX_INSTALL_DIR, unchanged (portable: resolved at runtime)
  kernels/<version>/              every kernel installed from v0.4.0 on: camoufox.exe, version.json, …
  version.json                    compatibility marker — see §1. Describes the root kernel when the root
                                  holds one; otherwise it mirrors the default kernel
  GeoLite2-City.mmdb              shared by every kernel
  addons/                         shared by every kernel
  camoufox.exe, …                 optional: a kernel installed by an older VFox, honoured in place
```

Invariants:

- **A kernel's location is derived from its version.** `<root>/kernels/<version>/`, and the directory
  name *is* the version. A mismatch is reported as a broken entry, never guessed around.
- **Nothing absolute is persisted.** A profile stores a version string; the root is resolved at
  runtime from `CAMOUFOX_INSTALL_DIR` exactly as today. Moving the product folder keeps working.
- **The legacy flat kernel is never moved.** Renaming ~1 GB while a browser may hold those files open
  is the one operation that can fail halfway, and "an installed kernel keeps working" is the point of
  the feature. It is reported as `location: 'legacy-root'` and otherwise behaves like any other kernel.
- **Shared data stays shared.** `camoufox-js` resolves the mmdb and addons from `INSTALL_DIR`
  (`locale.js:132`, `addons.js:48`), so per-kernel copies would be both duplication *and* invisible to
  the engine. One copy at the root, ~64 MB instead of ~64 MB per kernel.

---

## 3. What a profile stores, and what happens when the pin is missing

`ProfileSchema` gains `kernel: z.string().nullable().default(null)`.

| Profile | Resolves to | Pinned engine not installed |
| --- | --- | --- |
| `kernel: "X"` — explicit pin | kernel X | **refuse to launch**, actionable error |
| `kernel: null`, `identity.engine: "X"` — a store from before this feature | X if installed, else the default | launch on the default and **warn** |
| `kernel: null`, no identity — the oldest stores | the default kernel | the existing "engine not installed" flow |

"The default" is deterministic and needs no new persisted state:
`ENGINE_VERSION` if installed → else the legacy root kernel → else the newest installed.

**New profiles are pinned at creation** to the resolved default, so from v0.4.0 on every profile has
an explicit pin and can never drift. `kernel: null` then means exactly one thing: *this store was
written before the feature existed*. "Use the default engine" in the CLI/GUI writes the default's
version string rather than `null`, so it is a real, visible decision.

### The decision: refuse, do not fall back

The engine **is** the fingerprint — that is why `ENGINE_VERSION` is pinned at all, and why the
identity stores the engine it was born with. Launching a profile on a different build changes what it
reports to the sites it visits, silently, at exactly the moment the user believes they are reusing a
working fleet; and the change is invisible in the one place it matters, the site's view. A fallback
would also be undetectable after the fact: nothing in the store would record that the profile ran on
a different engine than the one it was pinned to.

The cost of refusing is bounded and recoverable — the user is told what is wrong, what is installed,
and the two ways out:

```
Cannot launch "Shop 04": it is pinned to engine 152.0.4-beta.28, which is not installed.
Installed: 152.0.4-beta.30 (default), 152.0.4-beta.26.
Fix: install 152.0.4-beta.28 (Settings → Engine), or re-pin this profile
(vfox profiles update <id> --kernel 152.0.4-beta.30). Launching on a different engine would
change the fingerprint this profile reports, so VFox refuses instead.
```

The refusal happens **before any process is spawned**, so a failed launch leaves no half-open window.
The GUI gets the reason as a code, not a sentence to pattern-match (§4).

The *unpinned* case is deliberately different: there is no contract to break, and refusing to launch
every profile because the user deleted a kernel would be hostile. It launches on the default and
says so — in the launch log, and in the GUI, which can compare `identity.engine` with the resolved
engine from data it already has.

---

## 4. Contract changes (`packages/shared` + every consumer, one commit)

- `ProfileSchema.kernel: string | null` (default `null`), `ProfileCreateSchema.kernel?: string`
  (`ProfileUpdateSchema` inherits). Additive with a default ⇒ an existing store parses unchanged.
- `KernelInfoSchema` keeps `installed` / `version` / `path` / `source` meaning **the default kernel**,
  so today's CLI output and settings panel keep working, and adds:

  ```ts
  kernels: Array<{
    version: string
    path: string                                   // runtime state, never persisted
    location: 'kernels' | 'legacy-root'
    bytes: number                                  // disk cost, measured on demand
    isDefault: boolean
    profileCount: number                           // who is pinned to it
  }>
  defaultVersion: string | null
  totalBytes: number
  ```

- `ProfileRuntimeSchema.errorCode: z.enum(['kernel_missing']).nullable().default(null)` — so the GUI
  offers the install action instead of matching English text (open question Q4).
- `Core.kernel`: `info()`, `install(version?)`, `remove(version)`, `on('progress')`.
  `install()` with no argument keeps today's meaning (`ENGINE_VERSION`).
- Routes: `POST /kernel/install` gains an optional `{ version }`; new `POST /kernel/remove { version }`.
- CLI: `vfox kernel info` prints one line per installed kernel (version · size · profiles pinned ·
  default) plus the total; `vfox kernel install [--version <v>]`; `vfox kernel remove <version>`;
  pinning through the existing `profiles update`.
- GUI: Settings → Engine becomes a list with install/remove and the total; the profile editor gets an
  Engine selector; a refused launch shows the message with the install action.

`KernelInfo.source` keeps `'bundled'` for now: removing an enum member is a breaking change for the
CLI and the renderer, and it does not belong in this PR.

---

## 5. Disk

- A second install adds one kernel and nothing else: mmdb and addons are shared (§2), re-installing an
  already-installed version is a no-op (no download, no extraction), and the staging archive is deleted
  after extraction — all of that is already true today.
- Sizes are **measured on demand** by walking each kernel directory when `kernel.info()` runs, not
  stored: a stored byte count is a second source of truth that goes stale the moment a user copies or
  edits a kernel directory. Cost will be measured and reported; if it turns out to be visible in the
  settings page, a cached count can be added later.
- `kernel.remove(version)` refuses while any profile pins that version or a browser is running from it,
  and names the profiles that block it.
- The pre-flight free-space check stays per-install (3 GB, unchanged); the UI shows the running total
  so the user can decide before adding another.

---

## 6. Outbound calls: still exactly three

Nothing here looks for updates. Installing is a user action and the set of installable versions is the
compile-time `ENGINE_VERSIONS` list — there is no version-discovery request. The root `version.json`
marker exists precisely so `camoufoxPath()` cannot start a download behind our back (§1.1), and the
resolver must be the only thing that decides which kernel is used, so no code path can call
`launchOptions` without an explicit `executable_path`.

---

## 7. Store migration

`kernel` defaults to `null`, so `ProfileSchema.parse` accepts a store written by the current version.
Test: a fixture `profiles.json` in today's shape (with `identity`, without `kernel`) → `list()` returns
`kernel: null` → resolution yields the installed kernel → the launch proceeds. It asserts the
**resolved engine path**, so it fails if the resolver ever starts refusing unpinned profiles. Written
red-first per AGENTS.md rule 5.

---

## 8. Evidence plan

Already measured, before any code exists: the §1.1 probes (executable-path override, shared-asset
resolution, and the 10-fetch download triggered by a missing root marker).

Local (this sandbox, no browser can start): resolution matrix (explicit pin / born-with / legacy
store / missing pin), the migration fixture, the refusal message and error code, the layout cases
(versioned, legacy root, broken directory name), `kernel.info()` sizes, CLI output.

CI, `e2e-engine` job: two kernels installed and two profiles launched against different pins, with raw
output showing two different `executablePath` values and both `version.json`s; GUI screenshots for the
disk cost and the missing-kernel dialog. The launch evidence is CI-only by construction (AGENTS.md §3).

---

## 9. Open questions for review

1. **Install semantics.** Installing a new version must not re-engine or re-pin existing profiles
   (proposed). It also does not move unpinned profiles, because a born-with engine that is installed
   wins over the default. Confirm that "install" is allowed to be a no-op for every existing profile.
2. **Version range.** v0.4.0 installs only versions from `ENGINE_VERSIONS` (the tested list, which
   already holds three). Arbitrary versions via `VFOX_ENGINE_URL` are a later feature.
3. **`kernel.remove` in v0.4.0?** The disk-cost requirement implies the user must be able to act on it;
   I propose yes, with the guard above.
4. **`errorCode` on `ProfileRuntime`** — accept the additive field, or leave the frozen schema untouched
   and let the GUI match the message text?
5. **Bulk re-pin** ("move every profile from X to Y") — useful after a kernel regression; I propose
   deferring it, since `profiles update` already allows a script.

## 10. Companion changes outside this task's scope (for the Lead)

- `scripts/kernel-path.mjs` calls `pkgman.launchPath()`, which throws once the root holds no engine
  (fresh installs place kernels under `kernels/`). It should report the default kernel via the new
  resolver.
- `README.md` (关于内核 section) and `docs/RELEASING.md` describe a single flat engine directory.
- CI caches the engine at `CAMOUFOX_INSTALL_DIR`; the cache path and key need to cover `kernels/<version>`.
