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
  /* 1 retry in CI and locally — enough to absorb a single transient infra blip,
   * but not enough to bury a hard-broken test the way `retries: 3` did before. */
  retries: 1,
  /* 1 in CI, deliberately, and staying that way. The suite already fans out as
   * 8 shard jobs, each with its own server + database, so cross-shard
   * parallelism carries the wall-clock and a second in-shard worker only adds
   * contention on a 2-core runner.
   *
   * Two mechanisms this comment used to blame were both wrong, and the record
   * is worth keeping. It was not web DB-pool contention (#4461): `/embed/**`
   * issues zero web-side Postgres statements, it fetches the backend over
   * HTTP. It was not the web event loop being pegged by
   * `/render/board` WASM renders either: in run 31857179523's
   * shard 7 the same server answered `/embed/gym/...` in 201 ms (a warm Next
   * Data Cache entry, no backend round trip) and `/` in 3.2 s (its own 3 s
   * backend deadline firing) while a `/embed/board/...` request sat stuck
   * for 30 s.
   *
   * #4463 found it: the GraphQL BACKEND's connection pool, exhausted by
   * concurrent copies of the home page's uncached `popularBoardConfigs`
   * statement — 82 s each on the dev database, and uncacheable here because
   * the CI backend runs with no REDIS_URL. Every spec that loaded `/` added
   * another copy, postgres.js's acquire queue is unbounded and untimed, and
   * every other backend read then waited forever. The backend now runs one
   * copy of those cold reads at a time, the SSR fetches that wait on it carry
   * SSR_BACKEND_FETCH_TIMEOUT_MS, and the `aa-` filename pin on the embed spec
   * is gone — the ordering it stood for is driven explicitly inside
   * e2e/embed-headers.spec.ts. */
  workers: process.env.CI ? 1 : undefined,
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

    /* Pin the emulated OS colour scheme to dark. The pre-paint theme-init
     * script (app/theme/theme-init-script.ts) falls back to
     * prefers-color-scheme when no saved preference exists — no spec seeds one —
     * so without this the runner's default (light) would flip every screenshot.
     * Dark keeps the pre-paint theme deterministic and matches the historical
     * SSR default. */
    colorScheme: 'dark',

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
  },

  /* Configure projects for major browsers */
  projects: [
    // Main functional E2E tests - desktop Chrome.
    // Screenshot-only specs are excluded here; they run in their own projects below.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // `production/` runs against a deployed host under its own config
      // (playwright.production.config.ts) — never against the local dev server.
      testIgnore: ['**/layout-screenshots.spec.ts', '**/expo-web/**', '**/production/**'],
    },

    // Expo-web smoke — drives the mobile app compiled for the browser at /app.
    // Requires the full expo-web dev stack (backend + Next proxy + Metro web):
    //   vp run test:e2e:expo-web            (orchestrated: starts the stack, runs this)
    // or vp run dev:mobile:web, then:
    //   PLAYWRIGHT_SKIP_CLASSIC_SETUP=1 \
    //   TEST_USER_EMAIL=test@boardsesh.com TEST_USER_PASSWORD=test \
    //     cd packages/web && vp exec playwright test --project=expo-web-smoke
    // (PLAYWRIGHT_SKIP_CLASSIC_SETUP=1 stops global-setup from seeding and
    // prewarming the classic Next routes the smoke never visits — under the
    // expo-web stack a cold compile of those routes can blow the setup's 30s
    // card timeout and fail the run before any smoke test starts.)
    // Viewport matches the Android parity reference (412×915) since the /app
    // surface renders the Material variant.
    {
      name: 'expo-web-smoke',
      use: {
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
      },
      // The suite is serial and its first test absorbs Metro's on-demand
      // compile of the whole web bundle when the stack is cold (a code edit or
      // cache clear invalidates the orchestrator's prewarm). The global 60s
      // per-test timeout would kill that test before the spec's 180s cold-load
      // budget could elapse, so give this project its own ceiling with
      // headroom over COLD_LOAD_TIMEOUT_MS.
      timeout: 240_000,
      testMatch: ['**/expo-web/*.spec.ts'],
    },

    // Board-layout screenshots - iPhone 16 Pro Max viewport.
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

  /* Run your local dev server before starting the tests. Skipped in CI and
   * whenever PLAYWRIGHT_TEST_BASE_URL points at an externally managed server —
   * notably the expo-web stack (scripts/expo-web-e2e.ts), where auto-starting
   * `vp run dev` here would race the orchestrator's Next instance for port
   * 3000 and kill the whole stack mid-run. */
  webServer:
    process.env.CI || process.env.PLAYWRIGHT_TEST_BASE_URL
      ? undefined
      : {
          command: 'vp run dev',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 120 * 1000,
        },
});
