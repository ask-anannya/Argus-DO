import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', 'tests'],
    },
    testTimeout: 5000,
    hookTimeout: 5000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    cache: {
      dir: 'node_modules/.cache/vitest',
    },
    reporters: ['dot'],
    passWithNoTests: true,
  },
});
