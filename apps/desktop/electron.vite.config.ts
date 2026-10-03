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
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})
