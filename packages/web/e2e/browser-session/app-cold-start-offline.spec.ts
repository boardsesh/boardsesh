import type { BrowserContext } from '@playwright/test';
import { expectSessionReadNames, openApp, readViewer, signInOnWww } from './helpers';
import { WWW_ORIGIN, type SeededAccount } from './stack';
import { expect, test } from './fixtures';

/**
 * What the app on app.boardsesh.test shows when its very first session read
 * fails at the network layer (review of #7810, round 2, "Issue worth
 * filing"): never the loading splash for good. One failed read is read again
 * and the app opens signed in; with www unreachable the app shows the
 * session-unavailable screen, and its retry, with the network back, lands the
 * climber in the app as the same account (a network failure is not a sign-out).
 */

const NETWORK_ERROR = 'Could not reach Boardsesh. Check your connection and try again.';
const SESSION_READ = /\/api\/auth\/session(?:\?|$)/;

/** Signs `account` in on www in its own tab, then closes it: the app tab opens as a returning climber. */
async function signedInBrowser(context: BrowserContext, account: SeededAccount): Promise<void> {
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, account);
  await expectSessionReadNames(wwwPage, account);
  await wwwPage.close();
}

test('app: a cold start whose first session read fails at the network recovers by itself; no endless splash', async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const account = freshAccount();
  await signedInBrowser(context, account);
  const appPage = await context.newPage();
  let failed = 0;
  await appPage.route(SESSION_READ, async (route) => {
    // Only the app's own read of www's session, and only the first one.
    if (failed > 0 || !route.request().url().startsWith(WWW_ORIGIN)) return route.fallback();
    failed += 1;
    await route.abort('failed');
  });
  await openApp(appPage);
  // Run 44422331673, both engines: the app reads the session again and opens signed in.
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });
  expect(failed).toBe(1);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: account.userId });
});

test('app: a cold start with www unreachable shows the retry screen, not the splash; the retry signs back in', async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const account = freshAccount();
  await signedInBrowser(context, account);
  const appPage = await context.newPage();
  let offline = true;
  let failed = 0;
  // Every read of www's session and token from the app fails at the network until the network is back.
  await appPage.route(/\/api\/(?:auth\/session|internal\/ws-auth)(?:\?|$)/, async (route) => {
    if (!offline || !route.request().url().startsWith(WWW_ORIGIN)) return route.fallback();
    failed += 1;
    await route.abort('failed');
  });
  await openApp(appPage);
  await expect(appPage.getByText(NETWORK_ERROR)).toBeVisible({ timeout: 120_000 });
  expect(failed).toBeGreaterThan(0);

  offline = false;
  await appPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(appPage.getByText(NETWORK_ERROR)).toHaveCount(0);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: account.userId });
});
