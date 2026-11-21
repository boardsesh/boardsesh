import { defineConfig, devices } from '@playwright/test';

/**
 * The browser-session harness (#7596, B7a): www and the Expo web app on two real
 * HTTPS subdomains of one parent domain, so a `Domain=` cookie on the parent is
 * shared between them, in Chromium and WebKit, against the real backend and a
 * real Postgres. The global setup starts every server and the proxy that makes
 * the browsers reach https://www.boardsesh.test and https://app.boardsesh.test.
 *
 *   vp run db:up                       (once)
 *   vp run test:e2e:browser-session
 *
 * See docs/auth/better-auth-browser-session.md, "Browser-session e2e harness".
 */
export default defineConfig({
  testDir: '.',
  globalSetup: require.resolve('./global-setup'),
  // The servers are shared and the specs sign the one seeded account in and out.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // harness-retry-reporter.ts fails the run when a test ran again for any reason but a lost WebKit context.
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: '../../playwright-report/browser-session' }],
        ['./harness-retry-reporter.ts'],
      ]
    : [['list'], ['./harness-retry-reporter.ts']],
  outputDir: '../../test-results/browser-session/artifacts',
  use: {
    // CI keeps the HTML report and server logs; a trace adds size, not signal.
    trace: process.env.CI ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    // next dev compiles a route the first time it is asked for it.
    navigationTimeout: 90_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // One more attempt, allowed only after WebKit's network process lost the context
    // (harness-retries.ts); the reporter fails the run for a retry after any other failure.
    { name: 'webkit', retries: 1, use: { ...devices['Desktop Safari'] } },
    {
      // The one project with the back/forward cache on: the full Chromium build
      // (the headless shell cannot have it) without playwright's
      // `--disable-back-forward-cache`. Runs only the probe and the acceptance-3
      // back/forward spec, which needs a restore.
      name: 'chromium-bfcache',
      testMatch: /(?:bfcache|acceptance-3-back-forward)\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] },
      },
    },
  ],
});
