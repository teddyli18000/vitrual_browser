import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite layout: src/main, src/preload, src/renderer -> out/{main,preload,renderer}.
 *
 * `externalizeDepsPlugin` keeps every runtime dependency (camoufox-js, playwright-core) as a real
 * import in the main bundle, while the bundled devDependencies (@vfox/server, @vfox/core,
 * @vfox/shared and their transitive CJS deps) are inlined so the packaged app cannot lose them to
 * pnpm's symlinked node_modules layout.
 *
 * The renderer is a normal web build: it talks plain HTTP/SSE to the loopback API and never
 * imports Electron or Node APIs.
 *
 * BOTH node-side bundles are emitted as CommonJS, and that is load-bearing:
 *  - `electron` is a CJS module whose exports are defined dynamically, so Node's ESM loader cannot
 *    see named exports and `import { BrowserWindow } from 'electron'` dies at instantiation with
 *    "does not provide an export named 'BrowserWindow'". Running the app proved it; no typecheck
 *    can.
 *  - a sandboxed preload script must be CommonJS anyway.
 * The `.cjs` extension keeps the format unambiguous even though this package is `"type": "module"`,
 * and `chunkFileNames` must carry it too — a `.js` chunk in this package would be read as ESM and
 * the CJS `require()` of it would fail.
 */

const cjs = {
  format: 'cjs' as const,
  entryFileNames: '[name].cjs',
  chunkFileNames: '[name]-[hash].cjs',
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: cjs } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: cjs } },
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
