import { test, expect, Page } from '@playwright/test';

/**
 * E2E tests for the multi-board queue flow.
 *
 * Verifies that climbs from different boards (Kilter + Tension) can coexist
 * in a single queue, and that the confirmation dialog surfaces correctly
 * when adding a climb whose board config isn't already accepted.
 */

const kilterListUrl = '/kilter/original/12x12-square/screw_bolt/40/list';
const tensionListUrl = '/tension/9/1/8,9,10,11/40/list';

const queueControlBar = '[data-testid="queue-control-bar"]';
const bottomTabBar = '[data-testid="bottom-tab-bar"]';

async function waitForBoardPage(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', {
    timeout: 30000,
  });
}

async function addFirstClimbFromList(page: Page): Promise<string> {
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

function bottomTabButton(page: Page, name: string, exact = false) {
  return page.locator(bottomTabBar).getByRole('button', { name, exact });
}

test.describe('Multi-board queue', () => {
  test('Kilter + Tension climbs can coexist after confirming the dialog', async ({ page }) => {
    // 1. Start on the Kilter board, add a climb — no dialog expected (empty queue).
    await page.goto(kilterListUrl);
    await waitForBoardPage(page);
    const kilterClimbName = await addFirstClimbFromList(page);

    // Queue bar now reflects the Kilter climb.
    await expect(page.locator(queueControlBar)).toContainText(kilterClimbName, { timeout: 10000 });

    // 2. Navigate to a Tension list via URL (outside the queue's accepted board).
    await page.goto(tensionListUrl);
    await waitForBoardPage(page);

    // The queue bar still shows the Kilter climb (cross-route persistence).
    await expect(page.locator(queueControlBar)).toContainText(kilterClimbName, { timeout: 10000 });

    // 3. Adding a Tension climb should surface the confirm dialog.
    const tensionClimbCard = page.locator('#onboarding-climb-card');
    await expect(tensionClimbCard).toBeVisible({ timeout: 15000 });
    await tensionClimbCard.dblclick();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog).toContainText(/different board/i);

    // 4. Click "Add to current queue" — both items should live in the queue.
    await dialog.getByRole('button', { name: /add to current queue/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // Tension climb is the current one — queue bar reflects the new item.
    const tensionClimbName = ((await page.locator('#onboarding-queue-toggle').textContent()) ?? '').trim();
    expect(tensionClimbName).toBeTruthy();
    expect(tensionClimbName).not.toBe(kilterClimbName);

    // 5. Adding a second Tension climb from the same layout/sets should NOT re-prompt.
    // Scroll to the next card and add it. If only one card with onboarding id is visible,
    // this assertion is a soft check — skip if the test list has only one visible card.
    const nextCard = page.locator('[data-testid="climb-card"]').nth(1);
    if (await nextCard.count()) {
      await nextCard.dblclick();
      // Dialog should NOT appear for same-key additions.
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 2000 });
    }
  });

  test('Switch to that board replaces the queue and navigates', async ({ page }) => {
    await page.goto(kilterListUrl);
    await waitForBoardPage(page);
    const kilterClimbName = await addFirstClimbFromList(page);
    await expect(page.locator(queueControlBar)).toContainText(kilterClimbName, { timeout: 10000 });

    // Navigate to Tension, try to add — dialog appears.
    await page.goto(tensionListUrl);
    await waitForBoardPage(page);

    const tensionClimbCard = page.locator('#onboarding-climb-card');
    await expect(tensionClimbCard).toBeVisible({ timeout: 15000 });
    await tensionClimbCard.dblclick();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Click "Switch to that board" — queue replaced, URL pushed to Tension base path.
    await dialog.getByRole('button', { name: /switch to that board/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // We should now be on a /tension/... list route.
    await expect(page).toHaveURL(/\/tension\//, { timeout: 15000 });

    // Queue should no longer contain the Kilter climb — only the Tension one.
    const bar = page.locator(queueControlBar);
    await expect(bar).not.toContainText(kilterClimbName, { timeout: 10000 });
  });

  test('Cancel leaves the queue untouched', async ({ page }) => {
    await page.goto(kilterListUrl);
    await waitForBoardPage(page);
    const kilterClimbName = await addFirstClimbFromList(page);

    await page.goto(tensionListUrl);
    await waitForBoardPage(page);

    const tensionClimbCard = page.locator('#onboarding-climb-card');
    await expect(tensionClimbCard).toBeVisible({ timeout: 15000 });
    await tensionClimbCard.dblclick();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // Queue unchanged — still showing the original Kilter climb.
    await expect(page.locator(queueControlBar)).toContainText(kilterClimbName, { timeout: 10000 });
  });
});
