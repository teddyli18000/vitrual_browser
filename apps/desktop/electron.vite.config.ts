import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Put the engine-extraction worker next to the bundled main process.
 *
 * `packages/core` starts it with `new Worker(new URL('./unzip-worker.js', import.meta.url))`. That is
 * correct in the source tree and **wrong once this config has bundled the main process**, because
 * `import.meta.url` becomes the bundle's own path — so the worker is looked for at
 * `out/main/unzip-worker.js`, which the bundler never emits, because a worker is not an entry point.
 * The shipped v0.3.0 failed every engine install with:
 *
 *     Cannot find module '…\resources\app.asar\out\main\unzip-worker.js'
 *
 * This lives in the build rather than in a script someone has to remember to call, because
 * `scripts/build-installer.mjs` runs `electron-vite build` directly and **bypasses the package's
 * `build` script** — which is exactly how the first attempt at this fix changed nothing and shipped
 * no worker at all. A main bundle without its worker can no longer be produced by any path.
 */
function engineWorkerPlugin() {
  return {
    name: 'vfox-engine-worker',
    apply: 'build' as const,
    closeBundle() {
      // `resolve` is relative to `apps/desktop`, which is the cwd for every electron-vite run.
      const source = resolve('..', '..', 'packages', 'core', 'dist', 'unzip-worker.js')
      const target = resolve('out', 'main', 'unzip-worker.js')

      if (!existsSync(source)) {
        throw new Error(
          `the engine worker ${source} does not exist. Build @vfox/core before apps/desktop — the ` +
            'worker is compiled with it.',
        )
      }

      mkdirSync(resolve('out', 'main'), { recursive: true })
      copyFileSync(source, target)

      const bytes = statSync(target).size
      if (bytes === 0) throw new Error(`${target} is empty`)
      console.log(`  vfox-engine-worker  out/main/unzip-worker.js (${bytes} bytes)`)
    },
  }
}

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
    plugins: [externalizeDepsPlugin(), engineWorkerPlugin()],
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
