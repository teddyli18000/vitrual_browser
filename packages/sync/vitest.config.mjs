import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    /**
     * Required by this machine's development sandbox, harmless everywhere else.
     *
     * Vite's Windows path handling bootstraps `safeRealpathSync` by running `net use` through
     * `child_process.exec`, which needs piped stdio — denied inside the sandbox, so the call
     * throws `spawn EPERM` and takes module resolution down with it. With `preserveSymlinks`
     * Vite skips `safeRealpathSync` entirely (`getRealPath()` returns early).
     *
     * The config is `.mjs` on purpose: Vite bundles a `.ts` config with esbuild, which spawns a
     * child process and hits the same restriction.
     */
    preserveSymlinks: true,
  },
  test: {
    // Vitest defaults to `pool: 'forks'`, which spawns child processes over piped stdio — the
    // same restriction. Worker threads need no pipes and behave identically on CI.
    pool: 'threads',
    include: ['test/**/*.test.ts'],
  },
})
