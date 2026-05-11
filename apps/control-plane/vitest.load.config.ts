import { defineConfig } from 'vitest/config';

const timeoutMs = Number(process.env.LOAD_TEST_TIMEOUT_MS ?? 180_000);

export default defineConfig({
  test: {
    globals: true,
    include: ['test/load/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: timeoutMs,
    hookTimeout: timeoutMs,
  },
});
