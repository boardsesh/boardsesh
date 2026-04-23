import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

/**
 * E2E tests for queue persistence across navigation.
 *
 * These tests verify that the queue state is preserved when navigating
 * away from the board page and back, using the queue bridge architecture.
 */

const bottomTabBar = '[data-testid="bottom-tab-bar"]';
const queueControlBar = '[data-testid="queue-control-bar"]';

// Helper to wait for the board page to be ready
async function waitForBoardPage(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', {
    timeout: 30000,
  });
}

// Helper to add a climb to the queue via double-click and return the climb name
async function addClimbToQueue(page: Page): Promise<string> {
  const climbCard = page.locator('#onboarding-climb-card');
  await expect(climbCard).toBeVisible({ timeout: 15000 });
  await climbCard.dblclick();
  await page.waitForSelector(queueControlBar, { timeout: 10000 });

  const queueToggle = page.locator('#onboarding-queue-toggle');
  await expect(queueToggle).toBeVisible({ timeout: 5000 });
  const climbName = ((await queueToggle.textContent()) ?? '').trim();
  expect(climbName).toBeTruthy();
  return climbName;
}

// Helper to verify the queue bar shows the expected climb
async function verifyQueueShowsClimb(page: Page, expectedClimbName: string, timeout = 5000) {
  const bar = page.locator(queueControlBar);
  await expect(bar).toBeVisible({ timeout: 10000 });
  await expect(bar).toContainText(expectedClimbName, { timeout });
}

// Scoped tab button selector to avoid ambiguity with multiple bars during transitions
function bottomTabButton(page: Page, name: string, exact = false) {
  return page.locator(bottomTabBar).getByRole('button', { name, exact });
}

test.describe('Queue Persistence - Local Mode', () => {
  const boardUrl = '/kilter/original/12x12-square/screw_bolt/40/list';

  test.beforeEach(async ({ page }) => {
    await page.goto(boardUrl);
    await waitForBoardPage(page);
  });

  test('queue should persist when navigating to home and back', async ({ page }) => {
    const climbName = await addClimbToQueue(page);

    // Navigate to home via bottom tab bar (client-side navigation preserves state)
    await bottomTabButton(page, 'Home').click();
    await expect(page).toHaveURL('/', { timeout: 15000 });

    // Queue bar should show same climb on home page
    await verifyQueueShowsClimb(page, climbName);

    // Navigate back to the board via bottom tab bar
    await bottomTabButton(page, 'Climb', true).click();
    await expect(page).toHaveURL(/\/kilter\//, { timeout: 20000 });

    // Verify queue bar still shows same climb after returning
    await verifyQueueShowsClimb(page, climbName, 15000);
  });

  test('global bar should appear with correct climb when navigating away', async ({ page }) => {
    const climbName = await addClimbToQueue(page);

    // Navigate to home via bottom tab bar (client-side navigation)
    await bottomTabButton(page, 'Home').click();
    await expect(page).toHaveURL('/', { timeout: 15000 });

    // Queue control bar should show the same climb on the non-board page
    await verifyQueueShowsClimb(page, climbName);
  });

  test('queue control bar should persist correct climb across all pages', async ({ page }) => {
    test.slow(); // This test walks several pages with queue verification on each
    const climbName = await addClimbToQueue(page);

    // Next.js app-router `router.push` uses a React transition: URL stays
    // at the current page until the target route's RSC payload arrives.
    // /playlists and /feed both SSR against the backend, so under shard
    // contention a single slow query can push the wait past the default
    // 15 s. 30 s gives room for one round-trip retry.
    const NAV_TIMEOUT = 30_000;

    // Navigation order: Discover → Feed → Home → Climb.
    //
    // Earlier versions went Home first, then Discover. That sequence
    // reliably failed on shard 5: clicking Discover after a prior
    // router.push('/')  races against that transition's still-in-flight
    // RSC fetch. Next.js 15 can silently drop a second push while the
    // first is pending, so the URL never advanced. Going Discover first
    // (from the fully-committed board page) avoids the race entirely.
    //
    // /settings requires auth (3c4c5271); /help's Discover click suffered
    // the same race. Coverage of the drawer → Link pathway lives in the
    // bottom-tab-bar spec's queue-integration tests.

    // 1. Navigate to Discover via bottom tab bar (from the board page —
    //    no prior router.push in flight, so the navigation is reliable).
    await bottomTabButton(page, 'Discover').click();
    await expect(page).toHaveURL(/\/playlists/, { timeout: NAV_TIMEOUT });
    await verifyQueueShowsClimb(page, climbName);

    // 2. Navigate to Feed via bottom tab bar.
    await bottomTabButton(page, 'Feed').click();
    await expect(page).toHaveURL(/\/feed/, { timeout: NAV_TIMEOUT });
    await verifyQueueShowsClimb(page, climbName);

    // 3. Navigate to Home via bottom tab bar.
    await bottomTabButton(page, 'Home').click();
    await expect(page).toHaveURL('/', { timeout: NAV_TIMEOUT });
    await verifyQueueShowsClimb(page, climbName);

    // 4. Navigate back to climb list via bottom tab bar.
    // Board route re-mounts its own queue bar and restores from the
    // in-memory bridge state; keep the longer timeout it already had.
    await bottomTabButton(page, 'Climb', true).click();
    await expect(page).toHaveURL(/\/kilter\//, { timeout: Math.max(NAV_TIMEOUT, 20_000) });
    await verifyQueueShowsClimb(page, climbName, 15000);
  });

  test('clicking global bar thumbnail should keep current route and open play drawer context', async ({ page }) => {
    test.slow(); // Queue setup + navigation + thumbnail click
    const climbName = await addClimbToQueue(page);

    // Navigate to home via bottom tab bar (client-side navigation preserves queue state)
    await bottomTabButton(page, 'Home').click();
    await expect(page).toHaveURL('/', { timeout: 15000 });

    // Verify climb is still shown before clicking
    await verifyQueueShowsClimb(page, climbName);

    // Click the thumbnail button within the queue bar
    const queueBar = page.locator(queueControlBar);
    const thumbnailButton = queueBar.getByRole('button').first();
    await thumbnailButton.click();

    // Route should remain stable; thumbnail should activate/open play context instead of navigating to climb info.
    await expect(page).toHaveURL('/', { timeout: 10000 });
    await verifyQueueShowsClimb(page, climbName, 15000);
  });
});

test.describe('Queue Persistence - Board Switch', () => {
  test('queue should NOT persist across full page navigations (no IndexedDB persistence)', async ({ page }) => {
    const boardUrl1 = '/kilter/original/12x12-square/screw_bolt/40/list';
    const boardUrl2 = '/kilter/original/12x12-square/screw_bolt/45/list'; // Different angle

    // Navigate to first board and add a climb
    await page.goto(boardUrl1);
    await waitForBoardPage(page);
    await addClimbToQueue(page);

    // Full page navigation destroys in-memory state; queue is not persisted to IndexedDB
    await page.goto(boardUrl2);
    await waitForBoardPage(page);

    // Queue bar should NOT be visible (queue lost on full page reload)
    const bar = page.locator(queueControlBar);
    await expect(bar).not.toBeVisible({ timeout: 3000 });
  });
});
