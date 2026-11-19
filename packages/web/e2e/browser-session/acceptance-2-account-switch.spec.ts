import type { Page } from '@playwright/test';
import {
  fetchWsAuth,
  graphqlStatusWithToken,
  isSameDocument,
  markDocument,
  openApp,
  readViewer,
  signInOnWww,
  signInOverExistingSession,
  signOutOnWww,
  expectSessionReadNames,
} from './helpers';
import { WS_HOST, WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * #7596 acceptance 2, under AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium
 * and WebKit: www and the app subdomain open in one browser context as A; a
 * login as B on www revokes A's session (the login presents A's cookie). A
 * request carrying A's 15-minute token then gets a 401, a WebSocket opened
 * with A's token is closed by the backend, and the app tab reloads from the
 * root as B.
 *
 * And #6979 criterion 3's sign-out half: a sign-out on www signs the app
 * subdomain out at its next load.
 *
 * Headless tabs get no real focus change, so the spec dispatches `focus` and
 * `visibilitychange` on the app tab: the same listeners a real focus runs
 * (`auth-store.web.ts`). The app may also notice on its own, through its
 * socket's 4401 or a 401; either way the assertion is the reload.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const homeTab = (page: Page) => page.getByRole('tab', { name: 'Home', exact: true });
const emailField = (page: Page) => page.getByRole('textbox', { name: 'Email', exact: true });

/** What a real focus would run in the app tab. */
async function focusAppTab(page: Page): Promise<void> {
  await page.bringToFront();
  await page
    .evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    })
    .catch(() => undefined);
}

/**
 * A GraphQL WebSocket opened with `token` from a www page of another context,
 * so no reload of the app tab can take the record with it. Resolves once the
 * backend acknowledged it; the close code lands on `window.__socketClose`.
 */
async function openSocketWithToken(page: Page, token: string): Promise<void> {
  await page.evaluate(
    ({ url, authToken }) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url, 'graphql-transport-ws');
        const timer = setTimeout(() => reject(new Error('no connection_ack within 20 s')), 20_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken } }));
        socket.onmessage = (event) => {
          if ((JSON.parse(String(event.data)) as { type: string }).type !== 'connection_ack') return;
          clearTimeout(timer);
          resolve();
        };
        socket.onclose = (event) => {
          clearTimeout(timer);
          (window as unknown as { __socketClose?: number }).__socketClose = event.code;
          reject(new Error(`closed with ${event.code} before the ack`));
        };
      }),
    { url: `wss://${WS_HOST}/graphql`, authToken: token },
  );
}

test("@smoke a login as B on www gives A's token a 401, closes A's socket and reloads the app tab as B", async ({
  context,
  openContext,
  freshAccount,
}) => {
  const accountA = freshAccount();
  const accountB = freshAccount();
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, accountA);
  await expectSessionReadNames(wwwPage, accountA);
  const appPage = await context.newPage();
  await openApp(appPage);
  await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });

  // A's 15-minute token, as the app holds it, works now.
  const tokenA = await fetchWsAuth(appPage);
  expect(tokenA).toMatchObject({ status: 200, authenticated: true, userId: accountA.userId });
  if (!tokenA.token) throw new Error('ws-auth gave A no token.');
  expect(await graphqlStatusWithToken(appPage, tokenA.token)).toBe(200);
  const probePage = await (await openContext()).newPage();
  await probePage.goto(`${WWW_ORIGIN}/auth/login`);
  await openSocketWithToken(probePage, tokenA.token);
  await markDocument(appPage);

  // Every document the app tab loads from here on, to see the reload start from the root.
  const appDocuments: string[] = [];
  appPage.on('request', (request) => {
    if (request.resourceType() === 'document') appDocuments.push(new URL(request.url()).pathname);
  });
  // B logs in on www in the same context, presenting A's cookie.
  await signInOverExistingSession(wwwPage, accountB);
  await expectSessionReadNames(wwwPage, accountB);
  expect((await readViewer(wwwPage)).userId).toBe(accountB.userId);

  expect(await graphqlStatusWithToken(wwwPage, tokenA.token)).toBe(401);
  await expect
    .poll(() => probePage.evaluate(() => (window as unknown as { __socketClose?: number }).__socketClose ?? null), {
      timeout: 30_000,
    })
    .toBe(4401);

  // The app tab reloads from the root, now as B.
  await expect
    .poll(
      async () => {
        await focusAppTab(appPage);
        return isSameDocument(appPage);
      },
      { timeout: 90_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(false);
  await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });
  // The reload starts at the root; the app then lands on its first tab as usual.
  expect(appDocuments[0]).toBe('/');
  expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: accountB.userId });
  const tokenB = await fetchWsAuth(appPage);
  expect(tokenB.userId).toBe(accountB.userId);
  if (!tokenB.token) throw new Error('ws-auth gave B no token.');
  expect(await graphqlStatusWithToken(appPage, tokenB.token)).toBe(200);
});

test('a sign-out on www signs the app subdomain out at its next load', async ({ context, freshAccount }) => {
  const account = freshAccount();
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, account);
  await expectSessionReadNames(wwwPage, account);
  const appPage = await context.newPage();
  await openApp(appPage);
  await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });
  const token = await fetchWsAuth(appPage);
  if (!token.token) throw new Error('ws-auth gave no token.');

  await signOutOnWww(wwwPage);
  expect((await readViewer(wwwPage)).authenticated).toBe(false);
  // The signed-out session's token is refused at once.
  expect(await graphqlStatusWithToken(wwwPage, token.token)).toBe(401);

  await focusAppTab(appPage);
  // The app may already be reloading by itself: a reply that landed after its marker went retires
  // the page. A reload that races that one is lost with the old document; the next load is the
  // app's own then, and what it shows is the same check.
  await appPage.reload().catch(async (error: unknown) => {
    if (!(error instanceof Error) || !/Not attached to an active page|ERR_ABORTED|interrupted/i.test(error.message))
      throw error;
    await appPage.waitForLoadState('load');
  });
  await expect(emailField(appPage)).toBeVisible({ timeout: 120_000 });
  await expect(homeTab(appPage)).toBeHidden();
  expect((await readViewer(appPage)).authenticated).toBe(false);
  expect(
    (await context.cookies()).filter((cookie) =>
      /boardsesh\.(?:bridged_)?session_token|next-auth\.session-token/.test(cookie.name),
    ),
  ).toEqual([]);
});
