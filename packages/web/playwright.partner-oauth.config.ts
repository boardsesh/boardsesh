import { defineConfig } from '@playwright/test';

/**
 * The partner OAuth journey (#6981 F18): one developer, one app, one climber,
 * on the real www pages and the real backend. The global setup starts both
 * servers against the dev database and puts an edge in front of them, so the
 * browser sees https://www.boardsesh.com and https://api.boardsesh.com.
 *
 *   vp run db:up                       (once)
 *   vp run test:e2e:partner-oauth
 *
 * See docs/integration-platform.md, "End-to-end journey".
 */
export default defineConfig({
  testDir: './partner-oauth-e2e',
  globalSetup: require.resolve('./partner-oauth-e2e/global-setup'),
  // The servers are shared and the journey is serial.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/partner-oauth' }]]
    : 'list',
  outputDir: 'test-results/partner-oauth/artifacts',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    // next dev compiles a route the first time it is asked for it.
    navigationTimeout: 90_000,
  },
});
