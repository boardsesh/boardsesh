import { type Page } from '@playwright/test';

// Three shapes of "a climb row is on screen": the classic list's onboarding
// anchor and card, and `static-climb-row.tsx`'s thumbnail — the only one the
// SSR front doors emit (W-15).
const CLIMB_CARD_OR_ONBOARDING = '#onboarding-climb-card, [data-testid="climb-card"], [data-testid="climb-thumbnail"]';

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
  //
  // The drawer/skeleton helpers that used to live below went with the last
  // spec that drove a drawer (`bottom-tab-bar.spec.ts`, W-16).
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
