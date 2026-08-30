import { defineConfig, devices } from '@playwright/test';

/**
 * Production boot smoke — a browser, pointed at a deployed host, and nothing else.
 *
 * Deliberately a SEPARATE config from playwright.config.ts rather than another
 * project inside it. That config carries `globalSetup`, which seeds data and
 * logs the test user in against whatever `baseURL` resolves to; running it
 * against production would write to production. There is no per-project opt-out
 * for globalSetup, so the only safe answer is a config that never declares one.
 *
 * No `webServer` either: the target is already deployed, and auto-starting a
 * local dev server would silently smoke localhost instead of the deploy.
 *
 *   PLAYWRIGHT_TEST_BASE_URL=https://app.boardsesh.com \
 *     vp exec playwright test --config=playwright.production.config.ts
 */
// Required rather than defaulted. Defaulting to production would mean a bare
// `playwright test --config=…` silently drives the live site, which is a
// surprising thing for a config to do on its own; an unset var should say so.
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL;
if (!baseURL) {
  throw new Error(
    'PLAYWRIGHT_TEST_BASE_URL is required for the production smoke — ' +
      'run `vp run smoke:app-boot`, or set it to the host you mean to check.',
  );
}

export default defineConfig({
  testDir: './e2e/production',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry: the edge can lag a few seconds behind a fresh deploy, and a
  // cold serverless route can miss the first navigation budget.
  retries: 1,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-all-retries',
    screenshot: 'only-on-failure',
    navigationTimeout: 60_000,
    ...devices['Desktop Chrome'],
  },
});
