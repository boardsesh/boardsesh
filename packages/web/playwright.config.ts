import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Verifies server reachability, test-user login, and pre-warms SSR routes
   * once before any worker starts. Fails fast with a precise error message
   * if seeded data has drifted. See e2e/SEED_CONTRACT.md. */
  globalSetup: require.resolve('./e2e/global-setup'),
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* 3 retries in CI to absorb infra timing noise; 1 locally to catch genuine flakes */
  retries: process.env.CI ? 3 : 1,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 2 : undefined,
  /* Global per-test timeout — some tests (zoom, login flows) need more than Playwright's 30 s default */
  timeout: 60_000,
  /* Raise the default assertion timeout from Playwright's 5 s to 10 s */
  expect: { timeout: 10_000 },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  /* In CI: emit HTML (artifact), GitHub Annotations, and a JSON file the
   * flake-report workflow consumes to surface tests that passed-on-retry. */
  reporter: process.env.CI
    ? [['html'], ['github'], ['json', { outputFile: 'playwright-report/results.json' }]]
    : 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',

    /* Trace every retry, not just the first. With `retries: 3`, the previous
     * `on-first-retry` setting meant retries 2 and 3 produced no trace —
     * exactly when a test is most stuck and the trace is most useful. */
    trace: 'on-all-retries',
    /* Capture a screenshot on failure for easier CI debugging */
    screenshot: 'only-on-failure',
    /* Timeout for individual actions (click, fill, etc.) */
    actionTimeout: 15_000,
    /* Timeout for page navigations */
    navigationTimeout: 30_000,
    /* Pre-seed the consent cookie so the bottom-anchored consent banner does
     * not cover bottom-of-viewport UI (tab bar, queue control bar, etc.)
     * during functional and screenshot specs. Specs that need the fresh
     * "no choice yet" state must override with
     *   test.use({ storageState: { cookies: [], origins: [] } });
     * The cookie value matches `serializeConsentCookie({ analytics: 'denied',
     * errorMonitoring: 'denied', decidedAt: <fixed>, version: 1 })` — we keep
     * everything denied so PostHog/Sentry stay off during tests and we don't
     * accidentally emit telemetry from CI. */
    storageState: {
      cookies: [
        {
          name: 'boardsesh:consent',
          value: 'a=0&e=0&v=1',
          domain: 'localhost',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 31_536_000,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
  },

  /* Configure projects for major browsers */
  projects: [
    // Main functional E2E tests - desktop Chrome.
    // Screenshot-only specs are excluded here; they run in their own projects below.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/app-store-screenshots.spec.ts', '**/layout-screenshots.spec.ts', '**/help-screenshots.spec.ts'],
    },

    // Help page screenshots - mobile viewport (390×844, iPhone 14 logical size).
    // Run in CI via the `screenshots` job; locally with:
    //   TEST_USER_EMAIL=test@boardsesh.com TEST_USER_PASSWORD=test \
    //     cd packages/web && bunx playwright test --project=help-screenshots
    {
      name: 'help-screenshots',
      use: { viewport: { width: 390, height: 844 } },
      testMatch: ['**/help-screenshots.spec.ts'],
    },

    // App Store screenshots - iPhone 14 Plus 6.5" (428×926 @ 3× = 1284×2778).
    // Run in CI via the `screenshots` job; locally with:
    //   cd packages/web && bunx playwright test --project=app-store-screenshots
    {
      name: 'app-store-screenshots',
      use: {
        viewport: { width: 428, height: 926 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      },
      testMatch: ['**/app-store-screenshots.spec.ts'],
    },

    // Board-layout screenshots - same iPhone 16 Pro Max viewport as app-store.
    // Captures every supported Kilter/Tension layout so board-rendering
    // regressions show up in the PR comment gallery.
    {
      name: 'layout-screenshots',
      use: {
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      },
      testMatch: ['**/layout-screenshots.spec.ts'],
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: process.env.CI
    ? undefined // In CI, we expect the server to be started separately
    : {
        command: 'bun run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});
