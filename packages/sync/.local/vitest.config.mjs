/**
 * Local-only test harness (not part of the package).
 *
 * The development sandbox on this machine denies piped child processes, which breaks both
 * esbuild's service (`spawn EPERM` while Vite transforms TypeScript) and vitest's default fork
 * pool. CI is unaffected and runs `vitest run` normally.
 *
 * Here the sources and tests are compiled with `tsc` first and vitest runs the resulting plain
 * JavaScript, so the same test files really do execute locally.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    pool: 'threads',
    include: ['out/test/**/*.test.js'],
  },
})
