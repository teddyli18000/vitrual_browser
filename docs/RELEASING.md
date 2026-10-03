# Releasing VFox

Everything a release produces is built by GitHub Actions on a stock `windows-latest` runner.
No local toolchain, no signing key and no secrets are required — and nothing is published
from a developer machine.

## Cut a release

```powershell
# 1. bump BOTH version files (scripts/version.mjs enforces that they agree)
#    package.json  ->  "version": "0.2.0"
#    apps/desktop/package.json -> "version": "0.2.0"

# 2. verify locally before tagging
node scripts/version.mjs --tag v0.2.0

# 3. commit, tag, push
git add package.json apps/desktop/package.json
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --follow-tags
```

Pushing a `v*` tag starts `.github/workflows/release.yml`. The same workflow can be run by
hand from the Actions tab (**Run workflow**, input `version` without the leading `v`); in
that case the tag is created at the workflow's commit.

A tag that does not match `package.json` fails the job in its first minute — that is the
point of `scripts/version.mjs`.

## What the release workflow does

| Step | Detail |
| --- | --- |
| Checkout | full history + tags, so an existing tag can be detected |
| Setup | `pnpm` version comes from `packageManager` in the root `package.json`; Node 24 |
| Version check | `node scripts/version.mjs --tag <tag>` |
| Engine version | `node scripts/kernel-version.mjs` — the version `camoufox fetch` would install |
| Engine cache | `actions/cache` on `.cache/camoufox`, key `camoufox-<os>-<engine version>` |
| Engine fetch | `node scripts/fetch-kernel.mjs` (~550 MB on a cache miss, seconds on a hit) |
| Build | `@vfox/shared`, `@vfox/core`, `@vfox/server` |
| Engine smoke test | `packages/core/scripts/smoke-launch.mjs` headless; fails the release if the engine does not launch and spoof |
| Package | `node scripts/build-installer.mjs` (electron-builder, `--win nsis zip --x64`) |
| Gate | `node scripts/verify-release.mjs` (see *Release gates*) |
| Publish | `gh release create` with the three assets attached |

The engine cache key is the **engine version**, not a lockfile hash: the ~550 MB download is
repeated exactly when Camoufox releases a new build, and never on an unrelated push. There
are deliberately no `restore-keys`, because restoring a stale engine costs a full 550 MB
transfer and is then replaced anyway.

## Artifacts a release publishes

| Asset | What it is |
| --- | --- |
| `VFox-Setup-<version>.exe` | NSIS installer, x64, per-user. Budget: **≤ 150 MB**. |
| `VFox-<version>-portable.zip` | Unpacked application; run `VFox.exe` from anywhere. |
| `SHA256SUMS.txt` | `sha256  filename` lines for the two files above. |

The installer deliberately does **not** contain the Camoufox engine; VFox downloads it on
first run (see below). That is why the installer is ~100 MB instead of ~1 GB.

## Verify a download

```powershell
Get-FileHash .\VFox-Setup-0.2.0.exe -Algorithm SHA256
# compare against the matching line in SHA256SUMS.txt
```

On Linux/macOS, with both files in one directory: `sha256sum -c SHA256SUMS.txt`.

## Release gates (`scripts/verify-release.mjs`)

The release fails unless every one of these holds:

1. All three assets exist and are non-zero, and `SHA256SUMS.txt` matches their real hashes.
2. `apps/desktop/electron-builder.yml` still carries `win.requestedExecutionLevel: asInvoker`,
   `nsis.perMachine: false`, `nsis.allowElevation: false`, `nsis.deleteAppDataOnUninstall: false`
   and no `fileAssociations` / `protocols` / `msi` / `squirrel` section.
3. The **PE `RT_MANIFEST` resource** of both the NSIS installer and the packaged `VFox.exe`
   declares `requestedExecutionLevel = asInvoker` (the resource is parsed, not byte-grepped).
4. `@electron/fuses` reports `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
   `EnableNodeCliInspectArguments` **disabled**, `OnlyLoadAppFromAsar` plus
   `EnableEmbeddedAsarIntegrityValidation` **enabled**, and
   `GrantFileProtocolExtraPrivileges` **enabled** (the packaged renderer loads from `file://`,
   so disabling that fuse ships a white screen) on the packaged executable.
5. No entry inside the portable zip uses an absolute path, a drive letter or `..`, and the
   zip carries both portable markers (`portable` and `data/`) — see *Installed vs portable*.
6. `camoufox-js` (with `dist/data-files`), `playwright-core` and impit's `.node` binary are
   present as real files in the packaged resources, `apps/desktop/out/main/index.js` is under
   2 MB and does not contain an inlined copy of camoufox-js.
7. Nothing in the built bundle calls `setAsDefaultProtocolClient`, `setLoginItemSettings`,
   `setUserTasks` or `registerFileAssociations`.
8. `VFox-Setup-<version>.exe` is at most **150 MB**, and the unpacked footprint of the
   portable zip is printed to the job summary so the size trend is visible per release.

The job summary also reports every artifact's exact size.

## What the installer touches on a user's machine

VFox installs per user. It never requests administrator rights and never elevates.

| Item | Path |
| --- | --- |
| Application | `%LOCALAPPDATA%\Programs\VFox` |
| Start Menu shortcut | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\VFox.lnk` |
| Desktop shortcut | `%USERPROFILE%\Desktop\VFox.lnk` |
| Uninstall entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<VFox>` |

Nothing else is created or modified:

- no file associations, no protocol handlers;
- no Windows service, no scheduled task, no auto-start entry, no shell extension;
- no machine-wide (`HKLM`) registry writes, no Program Files, no PATH changes.

Uninstalling removes exactly the four items above. The user's browser profiles live in
`%APPDATA%\VFox` and are **left intact** — `nsis.deleteAppDataOnUninstall` is `false` and the
release gate enforces it, so uninstalling can never destroy profile data.

On first launch VFox downloads the Camoufox engine (~493 MB browser + ~64 MB GeoIP database)
from the official [Camoufox releases](https://github.com/daijro/camoufox/releases) into the
local cache. That one-time download is the only network traffic VFox itself initiates: there
is no activation server, no licence key, no analytics and no update check.

## Installed vs portable

The two downloads store their data in different places, on purpose.

| | `VFox-Setup-<version>.exe` (installed) | `VFox-<version>-portable.zip` |
| --- | --- | --- |
| Data location | `%APPDATA%\VFox` | `<unzipped folder>\data` |
| Movable | no (a normal per-user install) | **yes** — move the whole folder anywhere |
| Uninstaller | yes | none (delete the folder) |

VFox resolves its data directory in this order:

1. `VFOX_DATA_DIR`, if the environment variable is set — it always wins;
2. otherwise, if a file named `portable` **or** a directory named `data` sits next to
   `VFox.exe`, the data directory is `<exe dir>\data` (portable mode);
3. otherwise `%APPDATA%\VFox`.

The portable zip ships both markers, so it is self-contained with no configuration at all:
`portable` (the switch, with an explanatory note) and `data/` containing a `README.txt`. The
`README.txt` is deliberate — zip tools are not required to preserve empty directories, and a
directory that does not survive extraction would silently drop the build back to `%APPDATA%`.
`scripts/verify-release.mjs` fails the release if either marker is missing from the zip, so a
"portable" build can never quietly become non-portable.

Moving the portable folder **together with its `data/` directory** carries the profiles, the
settings and the downloaded Camoufox engine with it. Nothing in a portable build may persist
an absolute path that would break after the move.

The markers are added by `scripts/portable-zip.mjs` after electron-builder has produced the
archive. They cannot come from electron-builder's `extraFiles`: that would also place them
inside the NSIS payload and would silently put the *installed* build into portable mode.

## Building the same artifacts locally

```powershell
. .\scripts\dev-env.ps1        # redirects every cache into ./.cache (gitignored)
node scripts/build-installer.mjs
```

Artifacts land in `./release/`, identical in name and layout to the CI ones.

> **Sandbox note.** On a machine confined by the DSH workspace-write sandbox, only the first
> half of that command completes. `scripts/build-installer.mjs` builds all four workspace
> packages successfully (it runs one `pnpm --filter` per package precisely so it can), and
> then stops with an exact, correctly-attributed error at the first step that needs a piped
> child process:
>
> - `electron-vite build` → esbuild's service process → `spawn EPERM`;
> - `electron-builder` → `npm`/`pnpm`, `app-builder` and `@electron/rebuild` → `spawn EPERM`;
> - `pnpm -r` (recursive) → `spawn EPERM`, which is why this script does not use it.
>
> Everything up to and including electron-builder's configuration parsing works. The
> packaging step itself must run on GitHub Actions or on an unconfined machine.

## Validating the workflows themselves

```powershell
node scripts/validate-workflows.mjs
```

This parses every file under `.github/` with a real YAML parser and asserts the repository's
own CI rules (every third-party action pinned to a full commit SHA with a `# version`
comment, local composite actions resolvable, cache steps complete, `release.yml` declaring
`permissions: contents: write`, every repository path named in a `run:` command existing on
disk). `actionlint` is intentionally not used: it is a system-level tool and this project
does not require one.
