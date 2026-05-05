import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/uat/**/*.test.ts'],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
