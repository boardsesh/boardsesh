/**
 * E2E regression test for the play view drawer's swipe-to-close animation.
 *
 * Bug: swiping the play drawer down to close looked janky — the drawer followed
 * the finger partway, then snapped back up toward the open position, then slid
 * all the way down to closed (one jerky motion). Pressing the close button
 * animated smoothly. The snap came from handing the gesture's inline-transform
 * animation over to MUI's `Slide` transition (the `open=false` flip) before the
 * paper was off-screen.
 *
 * This test drives a single-finger swipe-down via the Chrome DevTools Protocol
 * and samples the paper's computed `translateY` every animation frame, asserting
 * the close is a SINGLE MONOTONIC slide (no reversal/snap) that ends off-screen.
 *
 * Two variants cover the two gesture systems:
 *   - board area  → `usePullToClose` (packages/web/app/lib/hooks/pull-to-close.ts)
 *   - drag handle → MUI SwipeableDrawer → swipeable-drawer.tsx handleSwipeableClose
 */
import { test, expect, type ElementHandle, type Page } from '@playwright/test';

// Touch emulation is required so the CDP-dispatched touch events reach the
// gesture handlers. Override the chromium project defaults.
test.use({
  viewport: { width: 430, height: 932 },
  hasTouch: true,
  isMobile: true,
});

const listUrl = '/kilter/original/12x12-square/screw_bolt/40/list';

// Allow a small sub-pixel/compositor tolerance when asserting monotonicity. A
// real snap-back-toward-open moves the paper tens-to-hundreds of px the wrong
// way, far past this epsilon.
const MONOTONIC_EPSILON_PX = 6;

type PaperHandle = ElementHandle<HTMLElement>;

/**
 * Start a per-frame sampler that records the paper's computed `translateY`.
 * The paper element is resolved by Playwright (the visible drawer) and passed in
 * as a handle so we sample exactly that node — several keepMounted drawers share
 * the `data-swipeable-drawer` attribute and a naive in-page query is ambiguous.
 */
async function startSampler(page: Page, paper: PaperHandle): Promise<void> {
  await page.evaluate((paperEl) => {
    const win = window as unknown as { __pvSamples: number[]; __pvStop?: () => void };
    win.__pvSamples = [];
    let running = true;
    const tick = () => {
      if (!running) return;
      const matrix = new DOMMatrix(getComputedStyle(paperEl).transform);
      win.__pvSamples.push(matrix.m42);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    win.__pvStop = () => {
      running = false;
    };
  }, paper);
}

async function stopSampler(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __pvSamples: number[]; __pvStop?: () => void };
    win.__pvStop?.();
    return win.__pvSamples ?? [];
  });
}

/** Single-finger swipe down via CDP, from `start` moving `distance` px down. */
async function swipeDown(page: Page, start: { x: number; y: number }, distance: number, steps = 12) {
  const client = await page.context().newCDPSession(page);
  const pointAt = (y: number) => [{ x: start.x, y, id: 0, radiusX: 2, radiusY: 2, force: 1 }];

  // Always detach the CDP session, even if a dispatch throws mid-gesture, so it
  // doesn't leak across tests.
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pointAt(start.y) });
    for (let i = 1; i <= steps; i++) {
      const y = start.y + (distance * i) / steps;
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pointAt(y) });
      await page.waitForTimeout(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach();
  }
}

/** Assert the sampled translateY series is a single monotonic slide off-screen. */
function assertMonotonicClose(samples: number[], paperHeight: number) {
  // Drop the leading zeros captured before the gesture moved the paper.
  const firstMove = samples.findIndex((v) => v > MONOTONIC_EPSILON_PX);
  const motion = firstMove >= 0 ? samples.slice(firstMove) : samples;

  // The close must end off-screen.
  expect(Math.max(0, ...motion)).toBeGreaterThan(paperHeight * 0.85);

  // No reversal: every later sample must be >= the running max minus epsilon.
  // A snap back toward open makes a sample drop well below the prior peak.
  let peak = -Infinity;
  let minDropBelowPeak = 0;
  for (const value of motion) {
    if (value > peak) peak = value;
    const drop = peak - value;
    if (drop > minDropBelowPeak) minDropBelowPeak = drop;
  }
  expect(minDropBelowPeak).toBeLessThanOrEqual(MONOTONIC_EPSILON_PX);
}

type OpenDrawer = { paper: PaperHandle; box: { x: number; y: number; width: number; height: number } };

async function openPlayDrawer(page: Page): Promise<OpenDrawer> {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const firstCard = page.locator('#onboarding-climb-card, [data-testid="climb-card"]').first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await firstCard.tap();
  // The play drawer paper slides up; wait for it to settle on screen. Several
  // keepMounted swipeable drawers share the data attribute, so target the one
  // that is actually visible (`:visible`) rather than the first in the DOM.
  const paperLocator = page.locator('.MuiDrawer-paper[data-swipeable-drawer="true"]:visible').first();
  await expect(paperLocator).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const paper = (await paperLocator.elementHandle()) as PaperHandle | null;
  const box = await paperLocator.boundingBox();
  if (!paper || !box) throw new Error('play drawer paper handle/box unavailable');
  return { paper, box };
}

test.describe('Play view drawer — swipe to close', () => {
  test.setTimeout(120_000);

  test('board-area swipe closes with a single monotonic slide (no snap-back)', async ({ page }, testInfo) => {
    const { paper, box } = await openPlayDrawer(page);
    await startSampler(page, paper);

    // Start the swipe low in the drawer body (below the board, on the scrollable
    // climb details which sit at scroll-top) so it routes through usePullToClose,
    // and fling ~55% of the viewport down.
    const start = { x: box.x + box.width / 2, y: box.y + box.height * 0.55 };
    await swipeDown(page, start, page.viewportSize()!.height * 0.55);
    await page.waitForTimeout(450);

    const samples = await stopSampler(page);
    await testInfo.attach('board-swipe-translateY', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });

    assertMonotonicClose(samples, box.height);
    await expect(page).not.toHaveURL(/\/view\//, { timeout: 2000 });
  });

  test('drag-handle swipe closes with a single monotonic slide (no snap-back)', async ({ page }, testInfo) => {
    const { paper, box } = await openPlayDrawer(page);
    await startSampler(page, paper);

    // Start the swipe on the drag-handle zone (very top of the paper) so it
    // routes through MUI SwipeableDrawer → handleSwipeableClose.
    const start = { x: box.x + box.width / 2, y: box.y + 14 };
    await swipeDown(page, start, page.viewportSize()!.height * 0.55);
    await page.waitForTimeout(450);

    const samples = await stopSampler(page);
    await testInfo.attach('handle-swipe-translateY', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });

    assertMonotonicClose(samples, box.height);
    await expect(page).not.toHaveURL(/\/view\//, { timeout: 2000 });
  });
});
