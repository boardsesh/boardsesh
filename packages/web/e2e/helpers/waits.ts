import { expect, type Page, type Locator } from '@playwright/test';

const CLIMB_CARD_OR_ONBOARDING = '#onboarding-climb-card, [data-testid="climb-card"]';
const SWIPEABLE_DRAWER_VISIBLE = '[data-swipeable-drawer="true"]:visible';
const SKELETON = '.MuiSkeleton-root';

export async function waitForBoardListReady(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForSelector(CLIMB_CARD_OR_ONBOARDING, { timeout });
  // The climb-card selector goes visible the moment SSR HTML paints, which
  // can precede React's first client-side commit by a noticeable gap on
  // slower CI runners. Without a hydration guard, the very next click in
  // a test sometimes lands before the onClick handler is attached and is
  // silently dropped — the source of "clicked the button but nothing
  // happened" flakes in the help/layout screenshot specs. Two
  // consecutive `requestAnimationFrame` callbacks bracket at least one
  // React commit cycle, which is a cheap and reliable post-hydration
  // signal without needing a product-side marker.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export function drawer(page: Page, index = 0): Locator {
  return page.locator(SWIPEABLE_DRAWER_VISIBLE).nth(index);
}

export async function waitForDrawerOpen(page: Page, index = 0, timeout = 10_000): Promise<void> {
  await drawer(page, index).waitFor({ timeout });
}

export async function clickWithDomFallback(
  page: Page,
  trigger: Locator,
  options: {
    maxAttempts?: number;
    clickTimeout?: number;
    interAttemptMs?: number;
  } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 4;
  const clickTimeout = options.clickTimeout ?? 5_000;
  const interAttemptMs = options.interAttemptMs ?? 250;
  let lastFailure: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await trigger.click({ timeout: clickTimeout });
      return;
    } catch (clickError) {
      lastFailure = clickError;
      try {
        await trigger.evaluate((element: Element) => {
          if (element instanceof HTMLElement) {
            element.click();
            return;
          }
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        return;
      } catch (fallbackError) {
        lastFailure = fallbackError;
        if (attempt < maxAttempts - 1) {
          await page.waitForTimeout(interAttemptMs);
        }
      }
    }
  }

  if (lastFailure instanceof Error) {
    throw lastFailure;
  }
  throw new Error('Click did not complete after repeated attempts');
}

export async function clickUntilVisible(
  page: Page,
  trigger: Locator,
  target: Locator,
  options: {
    maxAttempts?: number;
    clickTimeout?: number;
    waitTimeout?: number;
    interAttemptMs?: number;
  } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 4;
  const clickTimeout = options.clickTimeout ?? 5_000;
  const waitTimeout = options.waitTimeout ?? 5_000;
  const interAttemptMs = options.interAttemptMs ?? 250;
  let lastFailure: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await clickWithDomFallback(page, trigger, {
        clickTimeout,
        maxAttempts: 1,
      });
      await target.waitFor({ state: 'visible', timeout: waitTimeout });
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt < maxAttempts - 1) {
        await page.waitForTimeout(interAttemptMs);
      }
    }
  }

  if (lastFailure instanceof Error) {
    throw lastFailure;
  }
  throw new Error('Target did not become visible after repeated clicks');
}

// Soft wait: if skeletons never fully unmount within the timeout, resolve
// rather than throw. Boardsesh renders MUI Skeletons in two patterns:
//   1. "page is loading data" — these unmount once the data arrives.
//   2. "image is still decoding" — these can linger as long as their
//      <Image> sibling is still loading network bytes. Some screenshots
//      need to fire before every last image decodes (the bluetooth
//      picker is the canonical case), so a strict assertion would
//      regress those.
// Callers that need a hard assertion can use the underlying expect()
// directly. The intent of this helper is "give visible loading
// affordances time to clear before snapping a screenshot."
export async function waitForSkeletonsGone(page: Page, timeout = 30_000): Promise<void> {
  try {
    await expect(page.locator(SKELETON)).toHaveCount(0, { timeout });
  } catch {
    // Soft-fail: caller's next assertion / screenshot is the real check.
  }
}
