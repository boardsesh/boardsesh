import { chromium, type FullConfig } from '@playwright/test';

const BOARD_URL = '/kilter/original/12x12-square/screw_bolt/40/list';
// The SSR front door's row marker (`static-climb-row.tsx`), plus the classic
// list's two, so this check keeps working either side of the W-16/W-17 cuts.
const CLIMB_ROW_SELECTOR = '[data-testid="climb-thumbnail"], #onboarding-climb-card, [data-testid="climb-card"]';
const WARMUP_PATHS = ['/playlists', '/feed'] as const;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';

class SetupError extends Error {
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\n\nHint: ${hint}` : message);
    this.name = 'E2E global-setup failed';
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // The expo-web smoke project drives the /app SPA, not the classic Next
  // routes this setup prewarms — under the expo-web stack the cold
  // classic-route compile can exceed the 30s card timeout and fail the run for
  // surfaces the smoke never visits. scripts/expo-web-e2e.ts sets the skip.
  if (process.env.PLAYWRIGHT_SKIP_CLASSIC_SETUP === '1') {
    console.info('[global-setup] PLAYWRIGHT_SKIP_CLASSIC_SETUP=1 — skipping classic-app prewarm.');
    return;
  }

  const baseURL = config.projects[0]?.use.baseURL ?? process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:3000';

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // 1. Server reachable + board route renders climb rows
    try {
      await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector(CLIMB_ROW_SELECTOR, { timeout: 30_000 });
    } catch (cause) {
      throw new SetupError(
        `Board URL ${BOARD_URL} did not render any climb rows within 30s.`,
        'Confirm the dev server is up at ' +
          baseURL +
          ' and the dev DB image is current (`docker compose down -v && vp run db:up`). ' +
          `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 2. Test user can log in
    try {
      await page.goto(`/auth/login?callbackUrl=${encodeURIComponent('/')}`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(TEST_USER_EMAIL);
      await page.getByLabel('Password').fill(TEST_USER_PASSWORD);
      await page.getByRole('button', { name: 'Login' }).click();
      await page.waitForURL('/', { timeout: 20_000 });
    } catch (cause) {
      throw new SetupError(
        `Test user ${TEST_USER_EMAIL} failed to log in.`,
        'Confirm the seeded dev DB image includes this user (the boardsesh-dev-db image ships ' +
          'test@boardsesh.com / test by default). Set TEST_USER_EMAIL/TEST_USER_PASSWORD if you ' +
          `intend to use a different account. Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 3. Pre-warm the SSR routes bottom-tab-bar navigates to. They call
    //    cached GraphQL on the server and trigger
    //    Next.js's compile-on-first-hit in dev. Without this, the first
    //    navigation in a test races a cold backend round-trip against the
    //    per-navigation timeout — the recurring shard-5 / shard-4 flake mode.
    for (const path of WARMUP_PATHS) {
      await page.goto(path, { timeout: 60_000, waitUntil: 'domcontentloaded' }).catch(() => {
        // Soft-fail: warmup is best-effort. If a warmup route is genuinely
        // broken the spec that depends on it will surface the failure.
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }
}
