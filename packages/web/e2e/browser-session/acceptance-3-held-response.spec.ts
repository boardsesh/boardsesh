import type { BrowserContext, Page, Route, WebSocketRoute } from '@playwright/test';
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
import { APP_ORIGIN, WS_HOST, WWW_ORIGIN, type SeededAccount } from './stack';
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
 * - The app: every GraphQL reply of the app tab's reload of A's profile is
 *   held; B signs in on www. A's name never shows, and the tab ends as B. A
 *   control with no switch shows that the same held replies do show A's name.
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
    // A page closed with a reply in flight disposes its request context; that reply goes nowhere.
    const response = await route.fetch().catch(() => undefined);
    if (!response) return;
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

/**
 * The app tab on A's profile (whose title is A's display name, from the
 * profile query), reloaded with every GraphQL reply held after the server
 * answered it. Until `releaseSockets`, no document of the tab reaches the real
 * socket: B's login revokes A's session and the backend's sweep would close
 * A's socket (4401) and reload the app by acceptance 2's path, so the reload
 * could not be told from the marker's (review of #7810, M1). Sockets opened
 * meanwhile connect when released.
 */
async function appHoldingAsA(context: BrowserContext, accountA: SeededAccount) {
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, accountA);
  await expectSessionReadNames(wwwPage, accountA);
  const appPage = await context.newPage();
  await openApp(appPage);
  await appPage.goto(`${APP_ORIGIN}/profile`);
  // The surface shows A's name when nothing is held, so the negative check below can fail.
  await expect(appPage.getByText(accountA.name).first()).toBeVisible({ timeout: 120_000 });

  // The run log gets every auth and GraphQL answer the app tab sees, so a tab that does not
  // reload shows which step it stopped at.
  const started = Date.now();
  appPage.on('response', (response) => {
    const url = new URL(response.url());
    if (!/\/(?:api\/auth\/session|api\/internal\/ws-auth|graphql)$/.test(url.pathname)) return;
    console.info(`[held-app] +${Date.now() - started} ms ${response.status()} ${url.host}${url.pathname}`);
  });
  let socketsReachServer = false;
  const waitingSockets: WebSocketRoute[] = [];
  await appPage.routeWebSocket(/\/graphql$/, (socket) => {
    if (socketsReachServer) socket.connectToServer();
    else waitingSockets.push(socket);
  });
  const held = await holdReplies(appPage, `https://${WS_HOST}/graphql`);
  // The reloaded document must have confirmed A (its session read, then ws-auth) before anything
  // else happens, and at least one reply must be held that it sent as A after that. Otherwise its
  // first read can already name B and nothing is held across a switch (run 44378153607, attempt 2).
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
  await expect(appPage.getByText(accountA.name)).toHaveCount(0);
  return {
    wwwPage,
    appPage,
    held,
    log: (line: string) => console.info(`[held-app] +${Date.now() - started} ms ${line}`),
    releaseSockets: () => {
      socketsReachServer = true;
      for (const socket of waitingSockets.splice(0)) {
        try {
          socket.connectToServer();
        } catch {
          // Its document is gone.
        }
      }
    },
  };
}

test("app control: with no switch, A's held GraphQL replies do land and show A's name", async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const accountA = freshAccount();
  const { appPage, held, releaseSockets } = await appHoldingAsA(context, accountA);
  held.release();
  await held.delivered();
  releaseSockets();
  // The same document, which the switched test below must never show.
  await expect(appPage.getByText(accountA.name).first()).toBeVisible({ timeout: 30_000 });
  expect(await isSameDocument(appPage)).toBe(true);
  // The app keeps asking; nothing held may outlive this test (run 44425414071 lost the next one to it).
  await appPage.unrouteAll({ behavior: 'ignoreErrors' });
});

test("app: GraphQL replies of A's, held across a switch to B on www, land nowhere; the marker reloads the app as B", async ({
  context,
  freshAccount,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const accountA = freshAccount();
  const accountB = freshAccount();
  const { wwwPage, appPage, held, log, releaseSockets } = await appHoldingAsA(context, accountA);

  await signInOverExistingSession(wwwPage, accountB);
  await expectSessionReadNames(wwwPage, accountB);
  expect(await isSameDocument(appPage), 'A’s document is still up when its replies are released').toBe(true);
  log(
    `releasing ${held.count()} replies; the app tab holds a marker: ${await appPage.evaluate(() => document.cookie.includes('boardsesh.viewer='))}`,
  );
  held.release();
  await held.delivered();
  // A's name never shows, in any document the tab holds for 3 s.
  await expectNothingOfALands(appPage, [accountA.name]);

  // No socket of the tab has reached the server yet, so no 4401 can have reloaded it: the
  // held replies landing under B's marker did.
  await expectReloadWithoutFocus(appPage);
  releaseSockets();
  await appPage.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(appPage.getByRole('tab', { name: 'Home', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(appPage.getByText(accountA.name)).toHaveCount(0);
  expect(new URL(appPage.url()).origin).toBe(APP_ORIGIN);
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: accountB.userId });
});
