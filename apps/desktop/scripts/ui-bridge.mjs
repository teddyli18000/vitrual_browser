/**
 * The `window.vfox` bridge used by the browser-driven harnesses, and the self-check for it.
 *
 * `screenshot-ui.mjs` and `flow-ui.mjs` both run the built renderer in Chromium with no Electron
 * behind it, so both need the same synthetic preload. It lives here rather than in each script
 * because the two must not drift: a bridge that satisfies the renderer in one harness and not the
 * other would make one of them prove nothing. It already drifted once — `saveText` was added for the
 * cookies export in one copy and not the other.
 *
 * DO NOT turn the injection back into a hand-built source string. It used to be one, and a single
 * stub was written as `profileUsage: async () => ${JSON.stringify(usage)}`. An arrow function with a
 * concise body needs an object literal parenthesised, so the emitted source was
 * `async () => {"path":"…"}`: `{…}` parsed as a function *body*, `"path"` became a string-literal
 * label, and the `:` was a syntax error. The whole injected script failed to parse, `window.vfox` was
 * never assigned, the renderer threw on `window.vfox.apiBase`, and the only symptom was a selector
 * timing out 30 s later. Passing a real function plus a plain-data argument lets Playwright
 * serialise both, so there is no hand-built source left to get wrong.
 */

import { join } from 'node:path'

/**
 * Mirrors what `src/preload/index.ts` exposes through contextBridge. The renderer cannot tell the
 * difference except for the capabilities that need Electron: `openPath`, `revealPath`,
 * `openHomepage`, `probeProxy`, `restartService`, `profileDir`, `profileUsage`, `saveExport`,
 * `saveText` and `pickImport` are stubbed here; everything else is the real code talking to the real
 * API. Keep this list in step with `VfoxBridge` in `src/shared/bridge.ts`.
 *
 * Playwright serialises this function and runs it in the page, so it must not close over anything:
 * everything it needs arrives in `bridge`, which is plain data.
 */
export function installBridge(bridge) {
  window.vfox = {
    apiBase: bridge.apiBase,
    token: bridge.token,
    version: bridge.version,
    platform: bridge.platform,
    dataDir: bridge.dataDir,
    dataMode: bridge.dataMode,
    serviceError: bridge.serviceError,
    openPath: async () => '',
    revealPath: async () => true,
    openHomepage: async () => 'https://github.com/teddyli18000/vitrual_browser',
    probeProxy: async () => ({ ok: true, ms: 18, message: 'TCP 连接成功' }),
    restartService: async () => ({
      ok: false,
      url: bridge.apiBase,
      token: '',
      error: '截图环境无法重启主进程',
    }),
    profileDir: async () => bridge.profileDir,
    profileUsage: async () => bridge.usage,
    saveExport: async () => ({ saved: false, path: null }),
    saveText: async () => ({ saved: false, path: null }),
    pickImport: async () => null,
  }
}

/** Plain data only — Playwright JSON-serialises this into the page as the function's argument. */
export function bridgeData(info) {
  const profileDir = join(info.dataDir, 'profiles', 'demo-profile', 'userdata')
  return {
    apiBase: info.apiBase,
    token: info.token,
    version: info.version,
    platform: info.platform,
    dataDir: info.dataDir,
    dataMode: info.dataMode,
    serviceError: info.serviceError,
    profileDir,
    usage: { path: profileDir, exists: true, bytes: 189_743_104, files: 4213 },
  }
}

/**
 * Reproduces Playwright's own serialisation — `coreBundle.js`: `(${fun.toString()})(${argString})` —
 * and parses it, without a browser and without executing it. This is the guard that would have
 * caught the unparenthesised-arrow-body bug before CI, and it costs microseconds.
 */
export function assertBridgeParses(data, label) {
  const source = `(${installBridge.toString()})(${JSON.stringify(data)})`
  try {
    // Parses the source without running it; `new Function` is the cheapest real parser available.
    new Function(source)
  } catch (error) {
    console.error(`The injected bridge script for "${label}" does not parse: ${error.message}`)
    console.error(source)
    process.exit(2)
  }
}
