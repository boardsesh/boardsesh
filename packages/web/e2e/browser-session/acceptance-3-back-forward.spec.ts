import type { Page } from '@playwright/test';
import {
  expectSessionReadNames,
  focusUntilReloaded,
  isSameDocument,
  markDocument,
  readViewer,
  signInOnWww,
  signInOverExistingSession,
} from './helpers';
import { WWW_ORIGIN, type SeededAccount } from './stack';
import { expect, test } from './fixtures';

/**
 * #7596 acceptance 3, back and forward, under AUTH_BROWSER_SESSION_MODE=better-auth:
 * after a switch from A to B, going back never leaves A's page up.
 *
 * - Back/forward cache, `chromium-bfcache` only (WebKit under Playwright never
 *   restores a page, bfcache.spec.ts: a real-Safari check for the owner). On
 *   the production build no signed-in page is restorable: www serves a
 *   signed-in /help and /settings `no-store` (run 44325488834:
 *   `response-cache-control-no-store`), so Chromium keeps neither, and the
 *   spec asserts that reason and that back loads B. `next dev` sends no such
 *   header, so there the page is restored with `persisted: true`, re-reads the
 *   session and is replaced (`session-provider.tsx`'s `pageshow` listener).
 * - Router Cache: A's /settings left by a client-side navigation and returned
 *   to with back. Only the production build has the cache that matters.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

type NavigationWithReasons = PerformanceNavigationTiming & { notRestoredReasons?: unknown };

/** A signs in, opens `path`, leaves it, B signs in in `other`, A's tab goes back. */
async function backAfterSwitch(page: Page, other: Page, path: string, a: SeededAccount, b: SeededAccount) {
  await signInOnWww(page, a);
  await expectSessionReadNames(page, a);
  await page.goto(`${WWW_ORIGIN}${path}`);
  // A page with a request still in flight is never kept (Chromium's rules); leave once it is idle.
  await page.waitForLoadState('networkidle');
  await markDocument(page);
  await page.evaluate(() => {
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) (window as unknown as { __restored?: boolean }).__restored = true;
    });
  });
  await page.goto(`${WWW_ORIGIN}/about`);
  await signInOverExistingSession(other, b);
  await expectSessionReadNames(other, b);
  const sessionReads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/session') sessionReads.push(request.method());
  });
  await page.goBack({ waitUntil: 'commit' });
  const restored = await page
    .evaluate(() => (window as unknown as { __restored?: boolean }).__restored === true)
    .catch(() => false);
  const reasons = await page
    .evaluate(() =>
      JSON.stringify(
        (performance.getEntriesByType('navigation')[0] as NavigationWithReasons).notRestoredReasons ?? null,
      ),
    )
    .catch(() => 'null');
  console.info(`[bfcache] ${path}: restored=${restored} notRestoredReasons=${reasons}`);
  return { restored, reasons, sessionReads };
}

test('back/forward cache: a signed-in /help of A is never kept by the production build, and under next dev is replaced as B', async ({
  context,
  freshAccount,
  stack,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-bfcache',
    'Only chromium-bfcache restores pages; WebKit under Playwright never does (bfcache.spec.ts): a real-Safari check.',
  );
  const accountB = freshAccount();
  const page = await context.newPage();
  const other = await context.newPage();
  const back = await backAfterSwitch(page, other, '/help', freshAccount(), accountB);
  testInfo.annotations.push({ type: 'bfcache', description: `/help restored=${back.restored}` });
  if (stack.wwwMode === 'production') {
    expect(back.restored, 'no signed-in page is restorable on the production build').toBe(false);
    expect(back.reasons).toContain('response-cache-control-no-store');
  } else {
    expect(back.restored, `/help was restored (notRestoredReasons ${back.reasons})`).toBe(true);
    await expect.poll(() => back.sessionReads.length, { timeout: 30_000 }).toBeGreaterThan(0);
  }
  await expect.poll(() => isSameDocument(page), { timeout: 60_000 }).toBe(false);
  expect(await readViewer(page)).toMatchObject({ authenticated: true, userId: accountB.userId });
});

test('back/forward cache: /settings, kept only by next dev, never leaves A up after back', async ({
  context,
  freshAccount,
  stack,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-bfcache', 'Only chromium-bfcache can restore pages.');
  const accountB = freshAccount();
  const page = await context.newPage();
  const other = await context.newPage();
  const back = await backAfterSwitch(page, other, '/settings', freshAccount(), accountB);
  if (stack.wwwMode === 'production') {
    expect(back.restored).toBe(false);
    expect(back.reasons).toContain('response-cache-control-no-store');
  } else {
    // next dev serves /settings without no-store, so Chromium keeps it and the restore path applies.
    expect(back.restored).toBe(true);
    await expect.poll(() => back.sessionReads.length, { timeout: 30_000 }).toBeGreaterThan(0);
  }
  await expect.poll(() => isSameDocument(page), { timeout: 60_000 }).toBe(false);
  expect(await readViewer(page)).toMatchObject({ userId: accountB.userId });
});

test('Router Cache: a client-side back to A’s /settings after the switch does not leave A up', async ({
  context,
  freshAccount,
  stack,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  test.skip(stack.wwwMode !== 'production', 'Only the production build has the Router Cache this checks.');
  const accountA = freshAccount();
  const accountB = freshAccount();
  const pageA = await context.newPage();
  await signInOnWww(pageA, accountA);
  await expectSessionReadNames(pageA, accountA);
  await pageA.goto(`${WWW_ORIGIN}/settings`);
  await expect(pageA.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
  await markDocument(pageA);
  // A client-side navigation away, so going back is served from the Router Cache.
  await pageA.locator('a[href="/"]').first().click();
  await pageA.waitForURL(`${WWW_ORIGIN}/`);
  expect(await isSameDocument(pageA), 'the link was a client-side navigation').toBe(true);

  const pageB = await context.newPage();
  await signInOverExistingSession(pageB, accountB);
  await expectSessionReadNames(pageB, accountB);
  await pageA.goBack();
  // A's page must not stay up under B: the guard re-reads on focus and reloads from the root.
  await focusUntilReloaded(pageA);
  expect(new URL(pageA.url()).pathname).toBe('/');
  expect(await readViewer(pageA)).toMatchObject({ userId: accountB.userId });
});
