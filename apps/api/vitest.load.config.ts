import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/load/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
