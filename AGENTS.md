# AGENTS.md — VFox

Two things only: **the principles the owner stated**, and **the traps agents hit**.

Product description, repository layout, API listings and run instructions belong in `README.md` and
`docs/`, not here. Before adding a line, ask: is this a principle, or a trap? If neither, it does not
belong in this file.

This file is maintained **as discoveries land**, not batched at the end of a task. If you learned
something a future agent would otherwise rediscover, write it here in the same turn.

---

## 1. The owner's principles

Quoted verbatim — a paraphrase loses the constraint.

### Lightweight and clean

- 「我希望尽可能做的轻量化一点，别占用太多，别堆屎山」 — as light as possible; do not pile up a mess.
- 「不准往我电脑上装任何东西」 — install nothing on my machine.
- 「portable 版本的，所有的数据都要在自己的文件夹里，可以整个移动」 — portable: all data inside its own
  folder, movable as a whole.

### Off limits

- 「涉及到付费的我们都不做，推广啥的都不做，云同步啥的也不做」 — nothing paid, no promotion, no cloud sync.
- **Zero telemetry.** The product itself may generate exactly three kinds of outbound traffic: the engine
  download on first run, the user's own configured proxy, and the GeoIP lookup when `fingerprint.geoip`
  is enabled. A new outbound call must be documented in `README.md` and justified in the PR.
- No secrets in the repo; proxy credentials live in the user's local profile store only.

### Where things run

- 「对于可能有危险的构建测试啥的，绝不能在我电脑上跑，放到 GitHub 上，反正无限额度」 — anything risky runs
  on GitHub, never on the owner's machine; CI quota is not a constraint.
- 「你本地你不好测，是吧？」 → **CI is the primary evidence.** No browser can start in this sandbox
  (Chromium dies on Mojo's named pipe), Electron cannot run, and the renderer cannot be built. So a
  browser-driven or packaged claim that has **not** run in CI has not been verified. Never dress a
  partial local run up as verification.

### How work is delivered

- 「你是领导你自己规划版本规划提交规划 pr 啥的，还有 issue，你自己管理好……版本该发布就发布，别全部
  堆在一起」 — the Lead plans versions, commits, PRs and issues, and releases when they are due rather
  than piling everything into one release.
- 「人家写完开了 pr，你还要让专门 review 的 agent 去审查，你把原则啥的给它规定好了……你自己也要大概
  看一下」 — every PR gets a dedicated reviewer with the principles spelled out, and the Lead reads it too.
- 「长期规划还有架构啥的，甚至是你检查出来的 bug，都别自己乱修，多拉几个 agent 来讨论」 — long-term
  plans, architecture and even bugs you found yourself: do not fix them unilaterally, bring several
  agents into the discussion.
- 「别再把主线搞坏了，要确保每一次迭代都正常」 — do not break main; every iteration must be sound.
- 「我不希望再拿到一个残次品」 — do not hand over a defective product.
- 「不要停下来直到做出一个满意的结果」 — do not stop until the result is satisfying.
- 「反正你看两个，一个 GitHub，一个 workbuddy」 — watch both GitHub and WorkBuddy.

### How we test

- 「我们现在就是要用 action 来在尽可能多的站点上检查我们的浏览器……全部在 action 用 playwright 拉着
  跑……反正 ci 免费，猛猛测」 — test the browser on as many sites as possible, all of it driven by
  Playwright in Actions; CI is free, so test hard.
- 「我指的检测指纹的网站，是那种专门检测的，**你要把结果拿回来看的**……单靠写代码是没法判断结果的」 —
  the dedicated fingerprint checkers, and **their results must be brought back and read**. Writing code
  cannot tell you the answer.
- 「弄好之后你通过 action，自己去试我们的指纹这些有没有问题，多试几个网站……然后要审查查证，不能犯这种
  低级错误」 — after building it, use Actions to test our fingerprint across many sites yourself, then
  review and verify; do not repeat低级 mistakes.
- 「你还要对齐优秀的，知道吗？自己去找，自己发版本迭代」 — align with the best products: find them
  yourself, then iterate and release.

### Experience

- 「有一个体验上的优化，不要一打开浏览器就是满屏知道吗？但也别太小」 — a profile window must not open
  full-screen, but must not be tiny either.
- 「这个你不能固定死了，因为我的电脑如果分辨率高你写的很小就会很小」 → window size is a **ratio** with a
  ceiling **relative to the work area**, never a pixel value. An absolute ceiling becomes a small window
  on a large display.

---

## 2. Discipline

Derived from the principles above, specific enough to execute.

1. A behaviour change starts as an issue. A non-trivial design is written down and reviewed **before**
   the code exists.
2. One concern per PR. The author does not review their own work.
3. Every PR is reviewed by someone who did not write it, reporting three things: **what was verified**
   (with raw output), **what was not verified**, and **what is still believed to be wrong**, ranked by
   how likely a user is to hit it. A review that only agrees is not a review.
4. **The Lead merges, never the author.** The Lead re-runs the gate on the same commit rather than
   trusting a summary — a summary is a claim, and claims are what reviews are for.
5. **Every assertion ships with the output of it going red.** A guard that has never failed has not been
   shown to test anything; a guard that scans zero inputs and returns green is worse than none, because
   it is believed. This repository has shipped that mistake twice.
6. Releases are cut from a green `main`, one at a time, and the packaged suite runs against **the artifact
   that ships**, not the build directory. `release/win-unpacked` is not what a user downloads; the
   portable zip and the installer are. v0.3.4 passed every check against the build directory and failed
   on every user's machine, because that directory let module resolution walk up into this repository's
   own `node_modules` — an environment the user does not have.
7. Before pushing a branch assembled from the shared working tree, check **both** directions:
   ```powershell
   git diff --stat origin/main                 # every hunk must belong to this task
   git diff origin/main | Select-String '^-'   # nothing that is on main may disappear
   ```
   The shared tree drifts behind `main` within hours. Work in a worktree from `origin/main`, and treat any
   file copied out of the shared tree as suspect until that diff is clean. Both failure modes happened on
   the same day: one assembly **reverted** work already on main, another **added** a file from a different
   branch.

---

## 3. Traps

### Engine and fingerprint

- **Pin `playwright-core` to exactly 1.60.0** (`camoufox-js` peer range is `<1.61.0`). Newer versions
  break the patched Juggler protocol.
- **A persistent profile and `wsEndpoint` are both available**, through the private path
  `firefox.launchServer({ ...opts, _userDataDir })` (`coreBundle.js:52555-52586`). Two private options
  are load-bearing: `_userDataDir` (otherwise a throwaway temp profile) and `_sharedBrowser: true`
  (the browser must survive the last automation client disconnecting). A guard test asserts the hook
  still exists — a silent Playwright bump must fail CI rather than downgrade every profile to a temp dir.
- **`better-sqlite3` is a real runtime dependency and must be built.** `camoufox-js/dist/webgl/sample.js`
  imports it and that WebGL sampler runs on **every launch**. Do not judge a dependency by grepping:
  looking for static imports in the top-level `dist/*.js` misses a nested one. `require('better-sqlite3')`
  is the only proof.
- **The engine re-rolls eight things on every launch**, so pinning `identity.fingerprint` alone is not
  enough: seven `CAMOU_CONFIG` keys (`canvas:seed`, `audio:seed`, `fonts:spacing_seed`,
  `canvas:aaOffset`, `canvas:aaCapOffset`, `window.history.length`, `window.screenY`) **plus a fresh
  WebGL sample**. All eight are pinned.
- **CAMOU_CONFIG travels in `env` as chunked variables** (`CAMOU_CONFIG_<n>`, 2047 chars per chunk), not
  in `options.config` — reading `options.config` shows nothing.
- **`_castToProperties` drops falsy values** (`fingerprints.js:13` opens with `if (!data) continue`), so
  a stored `innerWidth: 0` never reaches the engine.
- **The WebGL sampler is weighted by real-world GPU market share**, and `webgl_data.db`'s
  `win`/`mac`/`lin` columns are **float weights, not flags**. Measured over 2000 draws: only 15 of 32
  pairs ever appear, the top three cover 81%, a single GTX 980 row is 45%, and three profiles collided
  61.3% of the time. **Do not fix that by flattening the weights** — the real distribution is itself a
  fingerprint. Draw from the engine's own table but only over pairs **no other profile holds yet**, and
  `createBatch` must carry the whole batch's set: de-duplicating against the store alone still lets a
  batch collide with itself. **Re-drawing is not a fix** — with the popular pairs taken, what remains is
  rare and a bounded number of draws often misses. Select from the table, do not re-roll.
- **Reading a fingerprint value can be harder than spoofing it.** The engine smoke test reported
  `webglVendor: null` because a canvas element can only ever have **one** context type and the probe
  asked the same element for `webgl` after creating a `2d` context. One element per context. Before
  concluding a dimension is unspoofed, prove the probe can read it at all.

### Sandbox and local environment

- Source `. .\scripts\dev-env.ps1` before any node/pnpm/playwright/camoufox command (it redirects the
  caches into `./.cache/`).
- **The sandbox forbids setting any child stdio slot to `'pipe'`, and the ban is inherited by
  grandchildren.** That is what breaks esbuild, Electron, Playwright and Chromium's own subprocess
  sandbox. Chromium started with `stdio: 'ignore'` and driven over CDP still dies with
  `FATAL:mojo\public\cpp\platform\platform_channel.cc:112`, because **Mojo's platform channel is a named
  pipe**. Local UI screenshots and local packaged runs are therefore impossible.
- **A working local vitest recipe exists** (all four walls are beatable): a ~12-line preload that answers
  the `net use` probe locally, `--pool=threads` on the command line (no config file), and tests written
  as `.mjs` importing the built `dist/`. See `packages/server/test/{run-vitest.mjs,sandbox-preload.mjs}`.
  Otherwise fall back to `tsc` + `biome` + a throwaway harness over `dist`, or
  `node --test --test-isolation=none`. CI is unaffected either way.

### Packaging and release

- **A step that must happen for the packaged app to work belongs in `electron.vite.config.ts`, not on a
  package script.** `scripts/build-installer.mjs` runs `electron-vite build` directly and **never calls**
  `apps/desktop`'s `build` script, so anything chained onto it (`cmd && node extra.mjs`) silently does not
  run in CI or in a release. This shipped a real defect: v0.3.0 failed every install with
  `Cannot find module …\out\main\unzip-worker.js`.
- **The repository root `package.json` must NOT declare `"type": "module"`.** electron-builder extracts
  helper tools into `<repo>/.cache/electron-builder/`, inside the repo, so a root-level ESM field makes
  Node parse those CommonJS files as ESM and packaging dies with
  `ReferenceError: require is not defined in ES module scope`. Every script here is `.mjs`, so the field
  buys nothing.
- **`electron` must be pinned to an exact version.** electron-builder refuses a range because it downloads
  platform-specific binaries, and with `node-linker=hoisted` there is no
  `apps/desktop/node_modules/electron` to resolve the range from.
- **The Electron main process must be built as CJS.** With `"type": "module"` electron-vite emits ESM, and
  Electron's `electron` module is CommonJS with dynamically defined exports, so startup dies with
  `SyntaxError: … does not provide an export named 'BrowserWindow'`. The build succeeds and every
  typecheck passes — only running the app reveals it.
- **`noDefaultViewport: true`, never `viewport: null`.** `launchServer` validates against the server-side
  schema, whose only viewport field is `noDefaultViewport` (`coreBundle.js:20993`); `viewport: null`
  throws `ValidationError`.
- **`adm-zip` 0.5.x silently exports an empty directory tree on Windows.** `addLocalFolderAsync2` runs the
  path through `fixPath`, a zip-internal normaliser, so an absolute Windows path no longer exists and the
  ENOENT branch resolves with nothing added. Walk the directory with
  `fs.readdir(root, { recursive: true, withFileTypes: true })` and add files individually.
- **The engine is ~493 MB and is deliberately not committed and not bundled**; it is downloaded on first
  run.
- **Portable mode** resolves data in this order: `VFOX_DATA_DIR` → a `portable` marker or `data/` directory
  beside `process.execPath` → `app.getPath('userData')`. The portable zip ships the marker and an empty
  `data/`, and **nothing may persist an absolute path**, or moving the folder breaks it.
- **`koffi` ships prebuilt binaries for every platform**, so it needs no build step; adding it to
  `pnpm.onlyBuiltDependencies` only makes its postinstall fail with EPERM in the sandbox.
- **The store's atomic write can fail with EPERM on Windows** (a temp file renamed over a target another
  handle holds). It already retries 10 times over ~200 ms and can still fail — see issue #74.
