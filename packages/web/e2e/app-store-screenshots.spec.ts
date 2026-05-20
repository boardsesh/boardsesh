/* oxlint-disable no-restricted-globals -- e2e tests run in browser context with full storage access */
/**
 * App Store Screenshot Generation
 *
 * Captures screenshots at iPhone 14 Plus 6.5" resolution for App Store submission.
 * Screenshots are saved to mobile/screenshots/ for upload to App Store Connect.
 *
 * Run via the dedicated Playwright project (viewport set in playwright.config.ts):
 *   cd packages/web && bunx playwright test --project=app-store-screenshots
 *
 * Run with authenticated scenes (queue, party mode):
 *   TEST_USER_EMAIL=$(op read "op://Boardsesh/Boardsesh local/username") \
 *   TEST_USER_PASSWORD=$(op read "op://Boardsesh/Boardsesh local/password") \
 *   bunx playwright test --project=app-store-screenshots
 *
 * Prerequisites:
 *   - Dev server running: bun run dev
 *   - For authenticated tests: 1Password CLI installed and signed in
 *
 * Required App Store sizes:
 *   - 6.5" (iPhone 14 Plus): 1284x2778 -- screenshots taken at this logical size
 *   - 6.9" (iPhone 16 Pro Max): 1320x2868 -- App Store Connect accepts 6.5" for this slot
 *   - 12.9" iPad: 2048x2732 -- optional, not covered here
 */
import { expect, test } from '@playwright/test';
import path from 'path';
import {
  clickWithDomFallback,
  clickUntilVisible,
  drawer,
  waitForBoardListReady,
  waitForDrawerOpen,
  waitForSkeletonsGone,
} from './helpers/waits';

const SCREENSHOT_DIR = path.resolve(__dirname, '../../../mobile/screenshots');
const boardUrl = '/kilter/original/12x12-square/screw_bolt/40/list';

// Board-page screenshots: beforeEach navigates to the board list.
// Viewport and device settings come from the app-store-screenshots project in playwright.config.ts.
test.describe('App Store Screenshots', () => {
  // Seven tests all hitting the same board URL at 3× scale against a
  // single dev server. Running them serially eliminates parallel
  // contention (race on onboarding IDs, queue state, drawer animations)
  // at the cost of ~30s of wall-clock.
  test.describe.configure({ mode: 'serial' });

  // These are heavy pages at 3x scale -- give them room to load
  test.setTimeout(90_000);

  // Hide Next.js dev-mode indicator (the "N" badge + issue counter) so it
  // doesn't appear in App Store submissions. Runs before every navigation.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      const inject = () => document.head?.appendChild(style.cloneNode(true));
      if (document.head) inject();
      else document.addEventListener('DOMContentLoaded', inject);
    });
    // Suppress the web-only "Get the Boardsesh app" install prompt — it
    // never appears in the iOS build, so it shouldn't appear in App Store
    // screenshots either. The home-page-content reads this flag and
    // short-circuits to platform="native" without exposing the Capacitor
    // bridge to the rest of the app (which would have wider side effects
    // on Bluetooth, auto-connect, etc.).
    await page.addInitScript(() => {
      sessionStorage.setItem('boardsesh:e2e-suppress-install-card', '1');
    });
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForBoardListReady(page, 60_000);
  });

  test('01-climb-list', async ({ page }) => {
    // Main browse interface. Wait for every MUI skeleton to unmount so no
    // shimmering loading shadows leak into the shot. Once skeletons are
    // gone, the queue-hint intro animation gets a 600ms settle window.
    await waitForSkeletonsGone(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-climb-list.png` });
  });

  test('02-search-filters', async ({ page }) => {
    // Open the filters drawer (header button with aria-label="Open filters").
    // Note: `#onboarding-search-button` is the search input wrapper, not the
    // filter trigger — it focuses the textbox but does not open the drawer.
    await page.getByRole('button', { name: 'Open filters' }).click();
    await waitForDrawerOpen(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-search-filters.png` });
  });

  test('03-board-view', async ({ page }) => {
    // Tap the first climb's thumbnail — this is wired to select the climb
    // AND dispatch the open-play-drawer event, so it reliably lands in the
    // right state on both desktop and mobile without relying on dblclick.
    const thumbnail = page.locator('#onboarding-climb-card [data-testid="climb-thumbnail"]');
    await thumbnail.waitFor({ state: 'visible', timeout: 15_000 });
    await clickUntilVisible(page, thumbnail, drawer(page), {
      clickTimeout: 3_000,
      waitTimeout: 3_000,
      maxAttempts: 6,
    });
    // Board renderer fetches the layout SVG + hold images asynchronously after
    // the drawer animates in. Wait for the in-drawer skeletons to clear, then
    // a brief settle for SVG paint.
    await waitForSkeletonsGone(page, 20_000);
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-board-view.png` });
  });

  test('04-queue', async ({ page }) => {
    // Populate the queue using the only two stable selectors in list mode:
    // the first two onboarding-tagged rows. Click the second one twice so
    // the queue holds three items with at least one repeat — gives the
    // queue drawer real content while staying inside reachable selectors.
    const firstRow = page.locator('#onboarding-climb-card');
    const secondRow = page.locator('#onboarding-climb-card-2');
    await firstRow.waitFor({ state: 'visible', timeout: 15_000 });
    await secondRow.waitFor({ state: 'visible', timeout: 15_000 });

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    const selectedQueueClimb = queueBar.locator('#onboarding-queue-toggle').filter({ hasNotText: 'No climb selected' });
    await clickUntilVisible(page, firstRow, selectedQueueClimb, { waitTimeout: 3_000 });
    await clickWithDomFallback(page, secondRow);
    // Brief settle so the queue reducer applies the second add before the
    // third click — there's no per-add DOM signal that's safe to assert on
    // without depending on the climb name (varies per seed).
    await page.waitForTimeout(150);
    await clickWithDomFallback(page, firstRow);
    await page.waitForTimeout(150);

    // Open the play drawer (tap the thumbnail), then press the in-drawer
    // queue button so the screenshot shows the actual queue list, not the
    // climb browser with the queue bar at the bottom.
    const thumbnail = firstRow.locator('[data-testid="climb-thumbnail"]');
    await clickUntilVisible(page, thumbnail, drawer(page), {
      clickTimeout: 3_000,
      waitTimeout: 3_000,
      maxAttempts: 6,
    });

    // The play drawer's queue toggle can be in the DOM but not interactive
    // until the drawer's open animation settles. Without an explicit
    // visibility wait, the click fired on slow CI runners before the button
    // was hittable, producing the recurring 04-queue flake.
    const openQueueButton = page.getByRole('button', { name: 'Open queue' });
    await expect(openQueueButton).toBeVisible();
    await openQueueButton.click();
    // The queue drawer is the second swipeable drawer (stacked above play).
    await waitForDrawerOpen(page, 1);
    // Toggle history so previously-played climbs are listed alongside the
    // current one — otherwise the queue panel would only show the active
    // climb (already-played items are hidden by default).
    const historyToggle = page.locator('button:has(svg[data-testid="HistoryOutlinedIcon"])').first();
    await historyToggle.click().catch(() => {});
    // Wait for the Suggestions section's skeletons to unmount before the shot.
    await waitForSkeletonsGone(page, 20_000);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-queue.png` });
  });

  test('05-bluetooth', async ({ page }) => {
    // Web Bluetooth isn't available in Playwright's headless Chromium, so we
    // can't drive the real picker. Set the e2e flag that BluetoothProvider
    // honors to render DevicePickerDialog with three named demo devices
    // (Kilter / Tension / MoonBoard) — the screenshot mirrors what users see
    // when scanning for nearby boards.
    await page.addInitScript(() => {
      sessionStorage.setItem('boardsesh:e2e-bluetooth-picker', '1');
    });
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const dialog = page.getByRole('dialog').filter({ hasText: /select your board/i });
    await dialog.waitFor({ timeout: 15_000 });
    // Board-thumbnail SVGs inside each picker card load hold images
    // asynchronously. Wait for the in-dialog skeletons to clear, then a
    // brief settle for SVG paint.
    await waitForSkeletonsGone(page, 15_000);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-bluetooth.png` });
  });

  test('06-party-mode', async ({ page }) => {
    // Reuse the dummy SeshSettingsDrawer the onboarding tour uses — it's
    // mounted globally by OnboardingDummySeshMount and listens for a custom
    // event. This avoids hitting the real session backend for the screenshot.
    //
    // Poll the dispatch up to 10× because the event listener is attached in
    // a `useEffect` on the mount component, which can run after the test
    // body fires if hydration is still in progress. Each iteration re-fires
    // the event and waits 500ms for the drawer to mount.
    const drawerLocator = drawer(page);
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('onboarding:open-dummy-sesh'));
      });
      try {
        await drawerLocator.waitFor({ timeout: 500 });
        break;
      } catch {
        if (attempt === 9) throw new Error('Dummy sesh drawer never mounted after 10 dispatches');
      }
    }
    // Drawer animation settle.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-party-mode.png` });
  });

  // Home page (board selection) screenshot -- navigates away from boardUrl
  test('00-home', async ({ page }) => {
    await page.goto('/');
    // Wait for at least one board selection card before the screenshot.
    // The home page renders MuiCard-based selectors for each supported board.
    await page.locator('.MuiCard-root, [data-testid="board-selection-card"]').first().waitFor({ timeout: 15_000 });
    await waitForSkeletonsGone(page, 10_000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/00-home.png` });
  });
});
