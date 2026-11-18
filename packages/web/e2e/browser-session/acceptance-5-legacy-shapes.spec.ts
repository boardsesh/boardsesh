import type { Page } from '@playwright/test';
import { fetchWsAuth, openApp, readSession, readViewer } from './helpers';
import type { LegacySessionShape } from './legacy-session';
import { BRIDGED_COOKIE, COOKIE_DOMAIN, LOGIN_COOKIE, WWW_HOST, WWW_ORIGIN } from './stack';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 5 (and #6979 criterion 1), under
 * AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium and WebKit: a browser
 * signed in before the cutover holds only a NextAuth cookie. It stays signed
 * in on www and the app subdomain for each shape the design supports, normal,
 * chunked and host-only, with its `authSessionId` unchanged and one bridged
 * token for the whole visit: first reads that race may each write it, the
 * same value every time (acceptance 1's rule). A plain-named cookie on HTTPS
 * reads as signed out everywhere and bridges nothing (owner decision
 * 2026-11-18, "Cookie states"), as NextAuth's own read does in production.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const homeTab = (page: Page) => page.getByRole('tab', { name: 'Home', exact: true });
const emailField = (page: Page) => page.getByRole('textbox', { name: 'Email', exact: true });

const SUPPORTED: readonly LegacySessionShape[] = ['normal', 'chunked', 'host-only'];

for (const shape of SUPPORTED) {
  test(`@smoke a ${shape} pre-cutover cookie stays signed in on www and the app with one bridged token`, async ({
    context,
    page,
    freshAccount,
    legacySession,
    edgeCookies,
  }) => {
    const account = freshAccount();
    const minted = await legacySession.addTo(context, account, shape);
    const visit = await edgeCookies.during(async () => {
      await page.goto(`${WWW_ORIGIN}/settings`);
      await expect.poll(async () => (await readSession(page)).userId, { timeout: 20_000 }).toBe(account.userId);
      // The app learns the session from ws-auth; check it here so a broken read fails in seconds, not minutes.
      await expect
        .poll(async () => (await fetchWsAuth(page)).status, {
          timeout: 20_000,
          message: 'ws-auth for the bridged session',
        })
        .toBe(200);
      const appPage = await context.newPage();
      await openApp(appPage);
      await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });
      await expect(emailField(appPage)).toBeHidden();
      expect(await readViewer(appPage)).toEqual({
        authenticated: true,
        userId: account.userId,
        authSessionId: minted.authSessionId,
      });
      await page.reload();
    });

    const sessionWrites = sessionSetCookies(visit.records);
    const bridged = sessionWrites.filter((cookie) => cookie.name === BRIDGED_COOKIE && !cookie.clears);
    // As in acceptance 1: first reads that raced each bridge, to one token; every write is that cookie.
    expect(bridged.length).toBeGreaterThan(0);
    expect(new Set(bridged.map((cookie) => cookie.valueDigest)).size).toBe(1);
    for (const cookie of bridged) {
      expect(cookie).toMatchObject({ host: WWW_HOST, path: '/api/auth/session' });
      expect(cookie.attributes).toEqual(expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Secure', 'HttpOnly']));
    }
    // Nothing else: no login cookie, and the legacy cookie is kept for the rollback window.
    expect(sessionWrites.filter((cookie) => cookie.name !== BRIDGED_COOKIE)).toEqual([]);
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(LOGIN_COOKIE);
    expect((await context.cookies()).map((cookie) => cookie.name)).toEqual(expect.arrayContaining(minted.cookieNames));
    expect(await readViewer(page)).toEqual({
      authenticated: true,
      userId: account.userId,
      authSessionId: minted.authSessionId,
    });
  });
}

test('a plain-named pre-cutover cookie on HTTPS reads as signed out everywhere and bridges nothing', async ({
  context,
  page,
  freshAccount,
  legacySession,
  edgeCookies,
}) => {
  const account = freshAccount();
  await legacySession.addTo(context, account, 'plain-named');
  const visit = await edgeCookies.during(async () => {
    await page.goto(`${WWW_ORIGIN}/settings`);
    expect((await readSession(page)).userId).toBeNull();
    expect((await readViewer(page)).authenticated).toBe(false);
    const appPage = await context.newPage();
    await openApp(appPage);
    await expect(emailField(appPage)).toBeVisible({ timeout: 120_000 });
    expect((await readViewer(appPage)).authenticated).toBe(false);
  });
  expect(
    sessionSetCookies(visit.records).filter((cookie) => cookie.name === BRIDGED_COOKIE || cookie.name === LOGIN_COOKIE),
  ).toEqual([]);
});
