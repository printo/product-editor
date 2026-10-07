/**
 * Playwright smoke suite for the editor (docs/LARGE_FILE_SPLIT_PLAN.md, part 2
 * phase 0b). Local only: it drives the installed Google Chrome against the
 * local stack and a production build of this frontend. See e2e/README.md.
 */
import { defineConfig, devices } from '@playwright/test';
import { e2eEnv } from './e2e/support/env';

const env = e2eEnv();

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One at a time: the specs share the local backend and one server.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: env.baseUrl,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1366, height: 900 } }, testIgnore: /phone\.spec\.ts$/ },
    { name: 'phone', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /phone\.spec\.ts$/ },
  ],
  webServer: env.startServer
    ? {
        command: env.serverCommand,
        url: `${env.baseUrl}/login`,
        reuseExistingServer: true,
        timeout: 300_000,
        env: env.serverEnv,
      }
    : undefined,
});
