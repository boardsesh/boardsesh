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
    await page
      .waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', { timeout: 30000 })
      .catch(() => page.waitForLoadState('domcontentloaded'));
    // Wait for React hydration before firing any clicks
    await page.waitForLoadState('networkidle').catch(() => {});
  });

  test('main interface', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/main-interface.png` });
  });

  test('search filters', async ({ page }) => {
    // Open the filters drawer via the header button (aria-label="Open filters").
    await page.getByRole('button', { name: 'Open filters' }).click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/search-filters.png` });
  });

  test('search by hold', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });
    // Expand the combined Board accordion section (holds + zone).
    await page.getByText('Board', { exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/search-by-hold.png` });
  });

  test('heatmap', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });
    await page.getByText('Board', { exact: true }).click();
    await page.getByRole('button', { name: 'Show Heatmap' }).click();
    await page.waitForSelector('text=Loading heatmap...', { state: 'hidden', timeout: 10_000 }).catch(() => {});
    await page.waitForSelector('button:has-text("Hide Heatmap")', { state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/heatmap.png` });
  });

  test('climb detail', async ({ page }) => {
    // Tap the first climb's thumbnail — this selects the climb AND dispatches
    // the open-play-drawer event, so the play view shows climb details.
    const thumbnail = page.locator('#onboarding-climb-card [data-testid="climb-thumbnail"]');
    await thumbnail.waitFor({ state: 'visible', timeout: 15_000 });
    await thumbnail.click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/climb-detail.png` });
  });

  test('party mode modal', async ({ page }) => {
    // Add a climb so the queue bar renders, then open the "Start sesh"
    // drawer from inside the queue bar. Click the row itself — the
    // `.locator('..')` parent lookup used previously hit the virtualizer
    // container's dead space and often missed the onClick handler.
    const row = page.locator('#onboarding-climb-card');
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.click();

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    await expect(queueBar).toBeVisible({ timeout: 10_000 });

    await queueBar.getByText('Start sesh').click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/party-mode.png` });
  });

  test('login modal', async ({ page }) => {
    // Open user drawer → Sign in → auth modal with email/password form.
    await page.getByLabel('User menu').click();
    await page.getByRole('button', { name: 'Sign in' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('input#login_email', { state: 'visible' });
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
    await page
      .waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', { timeout: 30000 })
      .catch(() => page.waitForLoadState('domcontentloaded'));
    await page.waitForLoadState('networkidle').catch(() => {});

    // Login via user drawer → auth modal
    await page.getByLabel('User menu').click();
    await page.getByRole('button', { name: 'Sign in' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('input#login_email', { state: 'visible' });

    await page.locator('input#login_email').fill(testEmail);
    await page.locator('input#login_password').fill(testPassword);
    await page.locator('button[type="submit"]').filter({ hasText: 'Login' }).click();

    // Wait for the auth modal to close (login succeeded).
    await page.waitForSelector('input#login_email', { state: 'hidden', timeout: 15_000 });
  });

  test('personal progress filters', async ({ page }) => {
    await page.getByRole('button', { name: 'Open filters' }).click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });
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

  // Keep this last: starting a real party session mutates shared backend
  // state, so ordering it after the other tests avoids bleed-through.
  test('party mode active session', async ({ page, context }) => {
    test.slow();
    await context.grantPermissions(['geolocation']);

    // Click the row itself, not its virtualizer parent — see note on
    // `party mode modal` above.
    const row = page.locator('#onboarding-climb-card');
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.click();

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    await expect(queueBar).toBeVisible({ timeout: 10_000 });

    await queueBar.getByText('Start sesh').click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10_000 });

    // Submit the session-creation form (the footer "Sesh" button).
    await page.getByRole('button', { name: 'Sesh', exact: true }).last().click();
    await expect(page.getByText('Session started!')).toBeVisible({ timeout: 30_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/party-mode-active.png` });

    // Best-effort cleanup: try to stop the session so later runs start
    // clean. Ignored if the button label changed post-session.
    try {
      await page.getByRole('button', { name: 'Sesh', exact: true }).click({ timeout: 5_000 });
      await page
        .getByRole('button', { name: 'Stop Session' })
        .click({ timeout: 5_000 })
        .catch(() => {});
    } catch {
      // Ignore cleanup failures
    }
  });
});
