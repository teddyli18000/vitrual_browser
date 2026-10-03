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
