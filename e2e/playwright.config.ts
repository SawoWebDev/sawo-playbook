import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the real Docker stack (web → api → db/minio/gotenberg/mailpit).
 * Inside compose: BASE_URL=http://web-e2e:3000, MAILPIT_URL=http://mailpit:8025.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
