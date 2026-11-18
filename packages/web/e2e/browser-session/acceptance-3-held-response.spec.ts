import type { Page, Route } from '@playwright/test';
import {
  expectSessionReadNames,
  isSameDocument,
  markDocument,
  openApp,
  postCredentialsLogin,
  readViewer,
  signInOnWww,
  signInOverExistingSession,
} from './helpers';
import { APP_ORIGIN, WS_HOST, WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * #7596 acceptance 3, held replies, under AUTH_BROWSER_SESSION_MODE=better-auth,
 * in Chromium and WebKit. A reply that belongs to A is held after the server
 * committed it, B signs in on the OTHER host (so no same-origin message tells
 * the A tab), and the reply is released WHILE A's document is still up. For
 * three seconds after the release no toast and no A data may show in the tab,
 * whatever document it holds; then the tab ends as B, reloaded from the root
 * by itself, with no focus. This is the guard's "drop a superseded response"
 * path (design: "Mutation started as A, lands after a switch to B: the server
 * commits it to A, the caller gets superseded and shows nothing"), and the
 * viewer marker is how the tab learns of B when the reply lands (decision
 * "how the guard learns of an account switch on another host").
 *
 * - www: A deletes an ESP32 controller on /settings, a mutation whose success
 *   shows "Controller deleted successfully"; B signs in from app.boardsesh.com.
 * - The app: every GraphQL reply of the app tab's reload as A is held; B signs
 *   in on www. A's name never shows, and the tab ends as B.
 *
 * Back/forward navigation is in acceptance-3-back-forward.spec.ts.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const DELETED = 'Controller deleted successfully';

/** Holds every matching reply after the server answered it, until `release()`; `delivered()` once all landed. */
async function holdReplies(page: Page, url: string | RegExp, method?: string) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliveries: Promise<unknown>[] = [];
  await page.route(url, async (route: Route) => {
    if (method && route.request().method() !== method) return route.fallback();
    const response = await route.fetch();
    const delivery = released.then(() => route.fulfill({ response }).catch(() => undefined));
    deliveries.push(delivery);
    await delivery;
  });
  return { release, count: () => deliveries.length, delivered: () => Promise.all(deliveries) };
}

/** For `seconds`, none of `texts` shows in the tab, whichever document it holds. */
async function expectNothingOfALands(page: Page, texts: readonly string[], seconds = 3): Promise<void> {
  for (let check = 0; check < seconds * 4; check += 1) {
    for (const text of texts)
      expect(
        await page
          .getByText(text)
          .count()
          .catch(() => 0),
        `“${text}” shown`,
      ).toBe(0);
    await page.waitForTimeout(250);
  }
}

/** The tab replaces its document by itself, with no focus or other nudge, within 60 s. */
async function expectReloadWithoutFocus(page: Page): Promise<void> {
  await expect
    .poll(() => isSameDocument(page), {
      timeout: 60_000,
      intervals: [250, 500, 1_000],
      message: 'the tab reloads by itself after the account change',
    })
    .toBe(false);
}

test("www: A's controller deletion, held across a switch to B on the app host, shows nothing; the tab then reloads as B", async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const accountA = freshAccount();
  const accountB = freshAccount();
  const pageA = await context.newPage();
  await signInOnWww(pageA, accountA);
  await expectSessionReadNames(pageA, accountA);
  // A has one controller, registered through the guarded route the Settings card uses.
  const viewer = await readViewer(pageA);
  const registered = await pageA.evaluate(
    async (expectedViewer) =>
      (
        await fetch('/api/internal/controllers', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'X-Boardsesh-Expected-Viewer': expectedViewer },
          body: JSON.stringify({ name: 'A board', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' }),
        })
      ).status,
    `${viewer.userId}:${viewer.authSessionId}`,
  );
  expect(registered).toBe(200);
  await pageA.goto(`${WWW_ORIGIN}/settings`);
  await expect(pageA.getByText('A board')).toBeVisible({ timeout: 60_000 });
  await markDocument(pageA);

  const held = await holdReplies(pageA, `${WWW_ORIGIN}/api/internal/controllers`, 'DELETE');
  await pageA.getByRole('button', { name: 'Delete Controller' }).click();
  await pageA.getByRole('button', { name: 'Yes, delete' }).click();
  await expect.poll(held.count, { timeout: 30_000 }).toBe(1);

  // B signs in from the app host: no same-origin message reaches the www tab.
  const appPage = await context.newPage();
  await openApp(appPage);
  expect(await postCredentialsLogin(appPage, accountB)).toBe(200);
  await expectSessionReadNames(appPage, accountB);

  expect(await isSameDocument(pageA), 'A’s document is still up when its reply is released').toBe(true);
  held.release();
  await held.delivered();
  // No toast, and none of A's controllers, in any document the tab holds for 3 s.
  await expectNothingOfALands(pageA, [DELETED]);

  await expectReloadWithoutFocus(pageA);
  await pageA.waitForLoadState('load');
  expect(new URL(pageA.url()).pathname).toBe('/');
  await expect(pageA.getByText(DELETED)).toHaveCount(0);
  await expect(pageA.getByText('A board', { exact: true })).toHaveCount(0);
  expect(await readViewer(pageA)).toMatchObject({ authenticated: true, userId: accountB.userId });
});

test("app: GraphQL replies of A's, held across a switch to B on www, land nowhere; the app then reloads as B", async ({
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

  // The run log gets every auth and GraphQL answer the app tab sees, so a tab that does not
  // reload shows which step it stopped at.
  const started = Date.now();
  appPage.on('response', (response) => {
    const url = new URL(response.url());
    if (!/\/(?:api\/auth\/session|api\/internal\/ws-auth|graphql)$/.test(url.pathname)) return;
    console.info(`[held-app] +${Date.now() - started} ms ${response.status()} ${url.host}${url.pathname}`);
  });
  // Until the release, A's document opens no real socket: B's login revokes A's session and
  // the backend's sweep closes A's socket within a second, which reloads the app (acceptance
  // 2) before its held replies could land, so they would land nowhere (run 44355396120,
  // attempt 2). Sockets of any later document connect as usual.
  let socketsReachServer = false;
  await appPage.routeWebSocket(/\/graphql$/, (socket) => {
    if (socketsReachServer) socket.connectToServer();
  });
  const held = await holdReplies(appPage, `https://${WS_HOST}/graphql`);
  // The reloaded document must have confirmed A (its session read, then ws-auth) before B signs
  // in, and at least one reply must be held that it sent as A after that. Otherwise its first
  // read can already name B, the page is B's from the start, and nothing is held across a switch
  // (run 44378153607, attempt 2: one held reply, sent before the page knew anyone).
  const confirmedA = appPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/internal/ws-auth' && response.status() === 200,
    { timeout: 60_000 },
  );
  await appPage.reload({ waitUntil: 'commit' });
  await markDocument(appPage);
  await confirmedA;
  const heldBeforeA = held.count();
  await expect.poll(held.count, { timeout: 60_000 }).toBeGreaterThan(heldBeforeA);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: accountA.userId });

  await signInOverExistingSession(wwwPage, accountB);
  await expectSessionReadNames(wwwPage, accountB);
  expect(await isSameDocument(appPage), 'A’s document is still up when its replies are released').toBe(true);
  console.info(
    `[held-app] +${Date.now() - started} ms releasing ${held.count()} replies; the app tab holds a marker: ${await appPage.evaluate(() => document.cookie.includes('boardsesh.viewer='))}`,
  );
  socketsReachServer = true;
  held.release();
  await held.delivered();
  // A's name never shows, in any document the tab holds for 3 s.
  await expectNothingOfALands(appPage, [accountA.name]);

  await expectReloadWithoutFocus(appPage);
  await appPage.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(appPage.getByText(accountA.name)).toHaveCount(0);
  expect(new URL(appPage.url()).origin).toBe(APP_ORIGIN);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: accountB.userId });
});
