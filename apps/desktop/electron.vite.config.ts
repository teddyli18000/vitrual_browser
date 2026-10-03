import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite layout: src/main, src/preload, src/renderer -> out/{main,preload,renderer}.
 *
 * `externalizeDepsPlugin` keeps every runtime dependency (including the workspace packages
 * @vfox/server, @vfox/core and @vfox/shared) as a real ESM import in the main/preload bundles,
 * so the desktop app loads exactly the same code the CLI and the tests exercise — no duplicated
 * copy of the core inside the Electron bundle.
 *
 * The renderer is a normal web build: it talks plain HTTP/SSE to the loopback API and never
 * imports Electron or Node APIs.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The window runs with `sandbox: true`, and sandboxed preload scripts must be CommonJS:
        // an ESM preload would force `sandbox: false` and weaken the renderer isolation. `.cjs`
        // keeps the format unambiguous even though this package is `"type": "module"`.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      // Vite otherwise injects an inline <script type="module"> module-preload polyfill into
      // index.html, which the strict `script-src 'self'` policy in index.html would block.
      // Electron 38 supports modulepreload natively, so nothing is lost.
      modulePreload: { polyfill: false },
    },
    plugins: [vue()],
  },
})
