import type { Page, Route } from '@playwright/test';
import {
  focusUntilReloaded,
  isSameDocument,
  signInOverExistingSession,
  markDocument,
  openApp,
  readViewer,
  signInOnWww,
  expectSessionReadNames,
} from './helpers';
import { APP_ORIGIN, WS_HOST, WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * #7596 acceptance 3, under AUTH_BROWSER_SESSION_MODE=better-auth: a response
 * that belongs to A and is held across a switch to B lands nowhere under B: no
 * toast, no navigation, no cache write; and back/forward navigation after the
 * switch never shows A.
 *
 * - www (Chromium, WebKit): A sets a password on /settings, its reply is held
 *   by route interception after the server committed it, B logs in on www in
 *   another tab, then the reply is released. The A tab reloads at the root as
 *   B (A2's guard, through the BroadcastChannel) and never shows A's toast.
 * - The app (Chromium, WebKit): every GraphQL reply of A's reload is held, B
 *   logs in on www, the app tab is focused and reloads as B, then A's replies
 *   are released and nothing of A's appears.
 * - Back/forward cache (`chromium-bfcache` only): a www page of A restored by
 *   a back navigation after the switch fires `pageshow` with
 *   `persisted: true`, re-reads the session and does not show A. WebKit under
 *   Playwright never restores a page from the cache (bfcache.spec.ts), so that
 *   half is a real-Safari check for the owner.
 * - Router Cache (`BROWSER_SESSION_E2E_WWW=production`, the nightly): A's
 *   /settings left by a client-side navigation and returned to with back after
 *   the switch does not show A. `next dev` keeps no comparable cache, so the
 *   dev run skips it.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const PROFILE_ERROR = 'Failed to load profile';

/** Holds every matching reply after the server answered it, until `release()`. */
async function holdReplies(page: Page, url: string | RegExp) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(url, async (route: Route) => {
    const response = await route.fetch();
    held += 1;
    await released;
    await route.fulfill({ response }).catch(() => undefined);
  });
  return { release, count: () => held };
}

/** Never visible over a short watch after the held replies were let go. Polls, so a late toast is caught. */
async function expectNeverVisible(page: Page, text: string): Promise<void> {
  for (let check = 0; check < 10; check += 1) {
    expect(
      await page
        .getByText(text)
        .count()
        .catch(() => 0),
    ).toBe(0);
    await page.waitForTimeout(300);
  }
}

test("www: A's profile reply held across a switch to B shows nothing and the tab reloads as B", async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const accountA = freshAccount();
  const accountB = freshAccount();
  const pageA = await context.newPage();
  await signInOnWww(pageA, accountA);
  await expectSessionReadNames(pageA, accountA);
  // Settings reads the viewer's profile through the guarded transport on load; hold A's reply.
  const held = await holdReplies(pageA, `${WWW_ORIGIN}/api/internal/profile`);
  await pageA.goto(`${WWW_ORIGIN}/settings`);
  await markDocument(pageA);
  await expect.poll(held.count, { timeout: 60_000 }).toBeGreaterThan(0);

  const pageB = await context.newPage();
  await signInOverExistingSession(pageB, accountB);
  await expectSessionReadNames(pageB, accountB);
  // The A tab learns of the switch the way a climber's tab does, on focus, and reloads as B.
  await focusUntilReloaded(pageA);
  held.release();
  await pageA.unrouteAll({ behavior: 'ignoreErrors' });

  await pageA.waitForLoadState('load');
  await expectNeverVisible(pageA, PROFILE_ERROR);
  await expectNeverVisible(pageA, accountA.email);
  expect(new URL(pageA.url()).pathname).toBe('/');
  expect(await readViewer(pageA)).toMatchObject({ authenticated: true, userId: accountB.userId });
});

test("app: GraphQL replies of A's held across a switch to B land nowhere and the app reloads as B", async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const accountA = freshAccount();
  const accountB = freshAccount();
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, accountA);
  await expectSessionReadNames(wwwPage, accountA);
  const appPage = await context.newPage();
  await openApp(appPage);
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });

  const held = await holdReplies(appPage, `https://${WS_HOST}/graphql`);
  await appPage.reload({ waitUntil: 'commit' });
  await markDocument(appPage);
  await expect.poll(held.count, { timeout: 60_000 }).toBeGreaterThan(0);

  await signInOverExistingSession(wwwPage, accountB);
  await expectSessionReadNames(wwwPage, accountB);
  await focusUntilReloaded(appPage);
  held.release();
  await appPage.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });
  await expectNeverVisible(appPage, accountA.name);
  expect(new URL(appPage.url()).origin).toBe(APP_ORIGIN);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: accountB.userId });
});

test('back/forward cache: a page of A restored after the switch re-reads the session and is replaced', async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-bfcache',
    'Only chromium-bfcache restores pages; WebKit under Playwright never does (bfcache.spec.ts): a real-Safari check.',
  );
  const accountA = freshAccount();
  const accountB = freshAccount();
  const pageA = await context.newPage();
  await signInOnWww(pageA, accountA);
  await expectSessionReadNames(pageA, accountA);
  await pageA.goto(`${WWW_ORIGIN}/settings`);
  await expect(pageA.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
  await markDocument(pageA);
  await pageA.evaluate(() => {
    window.addEventListener('pageshow', (event) => {
      const record = window as unknown as { __restored?: boolean };
      if (event.persisted) record.__restored = true;
    });
  });
  await pageA.goto(`${WWW_ORIGIN}/help`);

  const pageB = await context.newPage();
  await signInOverExistingSession(pageB, accountB);
  await expectSessionReadNames(pageB, accountB);
  const sessionReads: string[] = [];
  pageA.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/session') sessionReads.push(request.method());
  });
  await pageA.goBack({ waitUntil: 'commit' });
  const restored = await pageA
    .evaluate(() => (window as unknown as { __restored?: boolean }).__restored === true)
    .catch(() => false);
  testInfo.annotations.push({ type: 'bfcache', description: `restored=${restored}` });
  expect(restored, 'the back navigation restored the page from the back/forward cache').toBe(true);
  // The restored page asks who is signed in, finds B, and goes: the guard's reload from the root.
  await expect.poll(() => sessionReads.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => isSameDocument(pageA), { timeout: 60_000 }).toBe(false);
  expect(await readViewer(pageA)).toMatchObject({ userId: accountB.userId });
});

test('Router Cache: a client-side back to A’s /settings after the switch does not show A', async ({
  context,
  freshAccount,
  stack,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'The back/forward cache project runs the test above.');
  test.skip(
    stack.wwwMode !== 'production',
    'next dev keeps no production Router Cache; the nightly runs this with BROWSER_SESSION_E2E_WWW=production.',
  );
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
  const softNavigation = await isSameDocument(pageA);
  testInfo.annotations.push({ type: 'router-cache', description: `soft navigation=${softNavigation}` });

  const pageB = await context.newPage();
  await signInOverExistingSession(pageB, accountB);
  await expectSessionReadNames(pageB, accountB);
  await pageA.goBack();
  // A's page must not stay up under B: the guard re-reads on focus and reloads from the root.
  await focusUntilReloaded(pageA);
  expect(new URL(pageA.url()).pathname).toBe('/');
  expect(await readViewer(pageA)).toMatchObject({ userId: accountB.userId });
});
