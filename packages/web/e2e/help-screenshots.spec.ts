/**
 * Help Page Screenshot Generation Tests
 *
 * These tests generate screenshots for the help page documentation.
 * They use a mobile viewport since the help screenshots show the mobile UI.
 *
 * Run via the dedicated Playwright project (viewport set in playwright.config.ts):
 *   cd packages/web && bunx playwright test --project=help-screenshots
 *
 * Run with authenticated tests using 1Password CLI:
 *   TEST_USER_EMAIL=$(op read "op://Boardsesh/Boardsesh local/username") \
 *   TEST_USER_PASSWORD=$(op read "op://Boardsesh/Boardsesh local/password") \
 *   bunx playwright test --project=help-screenshots
 *
 * Prerequisites:
 *   - Dev server running: bun run dev
 *   - For authenticated tests: TEST_USER_EMAIL and TEST_USER_PASSWORD env vars
 *     (default to the seeded dev user: test@boardsesh.com / test).
 */
import { test, expect } from '@playwright/test';
import { openDummySesh } from './helpers/dummy-sesh';
import { clickUntilVisible, drawer, waitForBoardListReady, waitForDrawerOpen } from './helpers/waits';

const SCREENSHOT_DIR = 'public/help';
const boardUrl = '/kilter/original/12x12-square/screw_bolt/40/list';

// Viewport (390×844) is set at the project level in playwright.config.ts.
// Both describe blocks here inherit it without needing their own test.use() calls.

test.describe('Help Page Screenshots', () => {
  // Serial mode so multiple tests don't race on the same onboarding IDs /
  // drawer animations — much less flaky than 4-wide parallelism.
  test.describe.configure({ mode: 'serial' });

  // Setup + drawer animations can chew through time on a cold dev server.
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForBoardListReady(page);
  });

  test('main interface', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/main-interface.png` });
  });

  test('search filters', async ({ page }) => {
    // Open the filters drawer via the header button (aria-label="Open filters").
    await page.getByRole('button', { name: 'Open filters' }).click();
    await waitForDrawerOpen(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/search-filters.png` });
  });

  test('search by hold', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await waitForDrawerOpen(page);
    // Expand the "Holds & Zone" accordion section (the panel was renamed when
    // hold and zone search were consolidated — see PR #1986).
    await page.getByText('Holds & Zone', { exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/search-by-hold.png` });
  });

  test('heatmap', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await waitForDrawerOpen(page);
    await page.getByText('Holds & Zone', { exact: true }).click();
    await page.getByRole('button', { name: 'Show heatmap' }).click();
    await page.waitForSelector('text=Loading heatmap...', { state: 'hidden', timeout: 10_000 }).catch(() => {});
    // The heatmap toggle is an icon-only IconButton — its label lives in the
    // aria-label, not in text content. `:has-text` only inspects DOM text, so
    // it never matched here even when the button was visible. Use getByRole
    // (matches accessible name, case-insensitive by default).
    await expect(page.getByRole('button', { name: 'Hide heatmap' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/heatmap.png` });
  });

  test('climb detail', async ({ page }) => {
    // Tap the first climb's thumbnail — this selects the climb AND dispatches
    // the open-play-drawer event, so the play view shows climb details.
    const thumbnail = page.locator('#onboarding-climb-card [data-testid="climb-thumbnail"]');
    await thumbnail.waitFor({ state: 'visible', timeout: 15_000 });
    await clickUntilVisible(page, thumbnail, drawer(page), {
      clickTimeout: 3_000,
      waitTimeout: 3_000,
      maxAttempts: 6,
    });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/climb-detail.png` });
  });

  test('party mode modal', async ({ page }) => {
    // Add a climb so the queue bar renders, then open the "Start sesh"
    // drawer from inside the queue bar. Click the row itself — the
    // `.locator('..')` parent lookup used previously hit the virtualizer
    // container's dead space and often missed the onClick handler.
    const row = page.locator('#onboarding-climb-card');
    await row.waitFor({ state: 'visible', timeout: 15_000 });

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    const selectedQueueClimb = queueBar.locator('#onboarding-queue-toggle').filter({ hasNotText: 'No climb selected' });
    await clickUntilVisible(page, row, selectedQueueClimb, { waitTimeout: 3_000 });

    const startSeshButton = queueBar.locator('[role="button"]').filter({ hasText: 'Start sesh' }).first();
    await clickUntilVisible(page, startSeshButton, drawer(page), {
      clickTimeout: 3_000,
      waitTimeout: 3_000,
    });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/party-mode.png` });
  });

  test('login modal', async ({ page }) => {
    // Open user drawer → Sign in → auth modal with email/password form.
    const userMenu = page.getByLabel('User menu');
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    const loginEmailInput = page.locator('input#login_email');
    await userMenu.waitFor({ state: 'visible', timeout: 15_000 });
    await clickUntilVisible(page, userMenu, signInButton);
    await clickUntilVisible(page, signInButton, loginEmailInput);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/login-modal.png` });
  });
});

// Authenticated tests - requires TEST_USER_EMAIL and TEST_USER_PASSWORD env vars.
// The seeded dev user (test@boardsesh.com / test) is exported by
// `vp run test:e2e:setup`, so no 1Password roundtrip is required.
test.describe('Help Page Screenshots - Authenticated', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const testEmail = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
  const testPassword = process.env.TEST_USER_PASSWORD ?? 'test';

  test.beforeEach(async ({ page }) => {
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForBoardListReady(page);

    // Login via user drawer → auth modal. Wait for the User menu trigger
    // to be both attached and visible — previously the test relied on
    // the (now-removed) `networkidle` wait to absorb the hydration gap
    // before this click; without it, the click can fire before the
    // header's onClick handler is mounted.
    const userMenu = page.getByLabel('User menu');
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    const loginEmailInput = page.locator('input#login_email');
    await userMenu.waitFor({ state: 'visible', timeout: 15_000 });
    await clickUntilVisible(page, userMenu, signInButton);
    await clickUntilVisible(page, signInButton, loginEmailInput);

    await loginEmailInput.fill(testEmail);
    await page.locator('input#login_password').fill(testPassword);
    await page.locator('button[type="submit"]').filter({ hasText: 'Login' }).click();

    // Wait for the auth modal to close (login succeeded).
    await page.waitForSelector('input#login_email', { state: 'hidden', timeout: 15_000 });
  });

  test('personal progress filters', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await waitForDrawerOpen(page);
    // Expand the Progress accordion (user-specific filters: attempts, completions).
    await page.getByText('Progress', { exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/personal-progress.png` });
  });

  // TODO: UserDrawer's "Classify Holds" button is gated on a `boardDetails`
  // prop that no caller in the current codebase actually passes (see
  // global-header.tsx — every `<UserDrawer boardConfigs={...} />` site omits
  // boardDetails). The wizard has no other entry point, so this screenshot
  // can't be captured until the app wires boardDetails through. Fix the
  // wiring or add a dedicated route, then flip fixme → test.
  test.fixme('hold classification wizard', async ({ page }) => {
    const userMenu = page.getByLabel('User menu');
    await userMenu.waitFor({ state: 'visible', timeout: 10_000 });
    await userMenu.click();
    await page.getByText('Classify Holds').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Classify Holds').click();
    await page.waitForSelector('.MuiRating-root, .MuiLinearProgress-root', {
      state: 'visible',
      timeout: 10_000,
    });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/hold-classification.png` });
  });

  test('settings aurora sync', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('.MuiCard-root', { state: 'visible' });
    await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h4, .MuiCardHeader-title')).find((el) =>
        el.textContent?.includes('Board Accounts'),
      );
      if (heading) {
        heading.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/settings-aurora.png` });
  });

  // Was: this test created a real party session against the backend and
  // waited for the `Session started!` toast. That timing depended on the
  // local-mode pub/sub backend (no Redis in CI), a WebSocket subscription,
  // and a "Sesh" submit button — three independent failure points that
  // produced one of the suite's worst flake rates (~10 of the last 30
  // failed runs on shard 7).
  //
  // It reuses the `OnboardingDummySeshMount` dispatch path, which mounts
  // the SeshSettingsDrawer without touching the session backend. The
  // screenshot still shows the active-session drawer; what it no longer
  // shows is a real backend handshake.
  //
  // If you ever need true backend coverage for session creation, move it
  // to a dedicated `party-session-integration.spec.ts` that runs on a
  // separate cadence — don't put it back in the screenshot job.
  test('party mode active session', async ({ page }) => {
    await openDummySesh(page);
    // 800ms settle for the drawer animation.
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/party-mode-active.png` });
  });
});
