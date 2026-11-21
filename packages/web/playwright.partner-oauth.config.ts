import { defineConfig } from '@playwright/test';

/**
 * The partner OAuth journeys (#6981 F18): owned developers, apps and climbers,
 * on the real www pages and the real backend. The global setup starts both
 * servers against the dev database and puts an edge in front of them, so the
 * browser sees https://www.boardsesh.com and https://api.boardsesh.com.
 *
 *   vp run db:up                       (once)
 *   vp run test:e2e:partner-oauth
 *
 * See docs/integrations/integration-platform.md, "End-to-end journey".
 */
export default defineConfig({
  testDir: './partner-oauth-e2e',
  globalSetup: require.resolve('./partner-oauth-e2e/global-setup'),
  // The servers are shared and the journeys are serial.
  workers: 1,
  fullyParallel: false,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/partner-oauth' }]]
    : 'list',
  outputDir: 'test-results/partner-oauth/artifacts',
  use: {
    // CI keeps the HTML report and server logs; a trace adds size, not signal.
    trace: process.env.CI ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    // next dev compiles a route the first time it is asked for it.
    navigationTimeout: 90_000,
  },
});
