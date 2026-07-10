import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    maxWorkers: 4,
    restoreMocks: true,
  },
});
