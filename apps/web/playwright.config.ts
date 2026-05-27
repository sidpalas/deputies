import { defineConfig, devices } from '@playwright/test';

const apiBaseUrl = process.env.VITE_API_BASE_URL ?? 'http://localhost:3583';
const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173';
const hostResolverRules = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: webBaseUrl,
    trace: 'on-first-retry',
  },
  webServer:
    process.env.PLAYWRIGHT_SKIP_WEB_SERVER === 'true'
      ? undefined
      : {
          command: 'pnpm dev --host 127.0.0.1',
          env: { ...process.env, VITE_API_BASE_URL: apiBaseUrl },
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: !process.env.CI,
        },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(hostResolverRules ? { launchOptions: { args: [`--host-resolver-rules=${hostResolverRules}`] } } : {}),
      },
    },
  ],
});
