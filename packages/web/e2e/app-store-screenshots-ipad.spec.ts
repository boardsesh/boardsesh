/**
 * App Store Screenshot Generation - iPad 12.9" / 13" Display
 *
 * Captures screenshots at iPad Pro 12.9" resolution for App Store submission.
 * Screenshots are saved to mobile/screenshots/ipad/ for upload to App Store Connect.
 *
 * Run (unauthenticated scenes only):
 *   bunx playwright test e2e/app-store-screenshots-ipad.spec.ts
 *
 * Run with authenticated scenes (queue, party mode):
 *   TEST_USER_EMAIL=$(op read "op://Boardsesh/Boardsesh local/username") \
 *   TEST_USER_PASSWORD=$(op read "op://Boardsesh/Boardsesh local/password") \
 *   bunx playwright test e2e/app-store-screenshots-ipad.spec.ts
 *
 * Prerequisites:
 *   - Dev server running: bun run dev
 *   - For authenticated tests: 1Password CLI installed and signed in
 *
 * Required App Store sizes for iPad 12.9" or 13" Displays:
 *   - 2048x2732px (portrait) or 2732x2048px (landscape)
 *   - 2064x2752px (portrait) or 2752x2064px (landscape)
 *   - Up to 3 app previews and 10 screenshots
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SCREENSHOT_DIR = path.resolve(__dirname, '../../../mobile/screenshots/ipad');

// Ensure output directory exists
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const boardUrl = '/kilter/original/12x12-square/screw_bolt/40/list';

// iPad Pro 12.9" logical viewport at 2x scale factor.
// 2048x2732 at 2x = 1024x1366 logical pixels.
const VIEWPORT = { width: 1024, height: 1366 };
const DEVICE_SCALE_FACTOR = 2;

test.describe('App Store Screenshots - iPad 12.9"', () => {
  test.setTimeout(90_000);

  test.use({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', { timeout: 60_000 })
      .catch(() => page.waitForLoadState('networkidle'));
  });

  test('01-climb-list', async ({ page }) => {
    // Main browse interface showing climb cards with grades and ratings
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-climb-list.png` });
  });

  test('02-search-filters', async ({ page }) => {
    // Open search drawer to show filtering options
    await page.locator('#onboarding-search-button').click();
    await page.getByText('Grade').first().waitFor({ state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-search-filters.png` });
  });

  test('03-board-view', async ({ page }) => {
    // Double-click first climb to add to queue, then open play drawer to show board
    const climbCard = page.locator('#onboarding-climb-card');
    await climbCard.dblclick();

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    await expect(queueBar).toBeVisible({ timeout: 10000 });

    // Open play drawer to show the climb on the board
    await page.locator('#onboarding-queue-toggle').click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-board-view.png` });
  });

  test('04-queue', async ({ page }) => {
    // Add multiple climbs to show the queue functionality
    const climbCards = page.locator('[data-testid="climb-card"], #onboarding-climb-card');
    const count = await climbCards.count();

    // Double-click up to 3 climbs to populate the queue
    for (let i = 0; i < Math.min(3, count); i++) {
      await climbCards.nth(i).dblclick();
      await page.waitForTimeout(300);
    }

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    await expect(queueBar).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-queue.png` });
  });

  test('05-bluetooth', async ({ page }) => {
    // Add a climb to get the queue bar, then open the Connect drawer
    const climbCard = page.locator('#onboarding-climb-card');
    await climbCard.dblclick();

    const queueBar = page.locator('[data-testid="queue-control-bar"]');
    await expect(queueBar).toBeVisible({ timeout: 10000 });

    // Click the "Connect to" button in the queue bar to open the connection drawer
    const connectButton = queueBar.getByLabel('Connect to');
    await expect(connectButton).toBeVisible({ timeout: 10000 });
    await connectButton.click();
    await page.locator('[data-swipeable-drawer="true"]:visible').first().waitFor({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-bluetooth.png` });
  });
});

// Home page screenshot (board selection) - separate describe since different URL
test.describe('App Store Screenshots - iPad 12.9" Home', () => {
  test.use({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('00-home', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // Wait for board selection cards to render
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/00-home.png` });
  });
});
