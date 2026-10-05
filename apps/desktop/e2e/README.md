# Where each kind of test belongs

This directory holds the tests that need a browser, a real window or a packaged artifact. Choosing the
wrong layer is expensive in both directions: a Playwright test for something a unit test could assert
costs minutes and tells you less when it fails, and a unit test for something only a browser can show
proves nothing at all.

## The map

| What is being asserted | Test | Runs as |
| --- | --- | --- |
| Contract, store, launcher options, mapping, archiving | `packages/*/test/**` | vitest, no browser |
| The engine installs from nothing and launches | `packages/core/scripts/verify-install.mjs` | real download, real process |
| The engine loads a page and spoofs the fingerprint | CI step `engine launch and fingerprint smoke test` | real browser over `firefox.connect` |
| A real visible window exists, with the right geometry, and its cookies survive a restart | `packages/core/scripts/verify-window.mjs` | real window, Win32 lookups |
| The packaged application works at all | `packaged-e2e.mjs` | spawns `VFox.exe`, drives it through its **own API** |
| The package contains what the bundled main process loads | `lib/artifact.mjs`, `artifact.selftest.mjs` | reads a real `.asar` |
| The renderer looks right | `scripts/screenshot-ui.mjs` | Playwright + Chromium against the built renderer |
| The renderer **works** | `scripts/flow-ui.mjs` | Playwright + Chromium, clicking |
| The engine windows orphan nothing | `packaged-e2e.mjs` phase 7 | Win32 window enumeration |

## The rules

1. **If a unit test can assert it, do not use a browser.** The engine's behaviour, the store's
   consistency, the fingerprint mapping, the CLI's output — all of it is cheaper and sharper in vitest.
   A browser test that fails tells you *something* is wrong; a unit test tells you *what*.

2. **Playwright for the renderer, because nothing else can reach it.** The renderer has no unit-level
   equivalent — it is a Vue application talking to a real server over SSE. `screenshot-ui.mjs` proves
   it *renders*; `flow-ui.mjs` proves it *works*. Both are needed, and they catch different things: a
   handler that stopped firing still produces a perfect screenshot.

3. **Playwright for the engine, through `firefox.connect(wsEndpoint)`, never CDP.** Firefox has no CDP
   endpoint. Anything determined by the engine — page content, fingerprint values, window geometry,
   cookie persistence — can only be observed from a real client attached to a real browser.

4. **Never Playwright for the packaged application.** The shipped fuses set
   `enableNodeCliInspectArguments: false`, and Playwright launches Electron with `--inspect=0`, so the
   client waits forever while the window opens normally. That hardening is deliberate and is not worth
   trading for test convenience. `packaged-e2e.mjs` therefore spawns `VFox.exe` as an ordinary process
   and drives it through its own HTTP API — which is also the contract a user's automation uses, so it
   is a better test than reaching into the renderer would have been.

5. **A screenshot is evidence about appearance, not about behaviour.** If a change can break the thing
   while every screenshot still looks correct, the screenshot is not the guard for it.

6. **Prove a browser test can fail before trusting it.** Reintroduce the defect, watch it go red, and
   check the message names the cause. This is not ceremony: a broken SSE route passed the whole server
   suite, because `createFakeCore` answered `runtime.list()` synchronously and beat Fastify to the
   reply every time. The fake was simply faster than any real store can be, and the suite was green.

## Known gaps

- **The synchroniser panel is never driven.** It is in the GUI, `packages/sync` has a real unit suite,
  and nothing exercises the two together.
- **The cookie import/export dialog is photographed but never used.** `7-cookies.png` shows it in its
  first-run state; no test performs an import and reads the skipped-line table back.
- **Portable mode is tested for the persisted state, not for a move.** The suite asserts that nothing
  in `profiles.json` caches an absolute path, which is the cheap half. Physically moving the folder —
  the property the marker exists for — is not covered, because the unpacked directory is several
  hundred megabytes with the engine in it.
- **The installer is never run.** `VFox-Setup-*.exe` is built and published; nothing installs it.
