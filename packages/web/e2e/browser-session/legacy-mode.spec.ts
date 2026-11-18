import type { Page } from '@playwright/test';
import { openApp, readViewer, signInOnWww } from './helpers';
import { COOKIE_DOMAIN, WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * Baseline, today's mode (`AUTH_BROWSER_SESSION_MODE` unset, NextAuth): one
 * browser context signs in on www, and the app subdomain, which never saw a
 * password, is signed in as the same account because the `Domain=.boardsesh.test`
 * session cookie rides its credentialed calls to www. Signing out on www signs
 * the app out. The Phase B specs run the same shape against `better-auth`.
 */

test.skip(
  !!process.env.AUTH_BROWSER_SESSION_MODE,
  'The baseline runs in legacy mode; AUTH_BROWSER_SESSION_MODE is set for this run.',
);

const homeTab = (page: Page) => page.getByRole('tab', { name: 'Home', exact: true });
const emailField = (page: Page) => page.getByRole('textbox', { name: 'Email', exact: true });
const sessionCookies = async (page: Page) =>
  (await page.context().cookies()).filter((cookie) => cookie.name.endsWith('next-auth.session-token'));

test('the app subdomain follows the www sign-in and sign-out', async ({ context, accountA }) => {
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, accountA);
  const wwwViewer = await readViewer(wwwPage);
  expect(wwwViewer.authenticated).toBe(true);
  expect(wwwViewer.userId).toBe(accountA.userId);

  // A second tab of the same browser context, on the app subdomain.
  const appPage = await context.newPage();
  await openApp(appPage);
  await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });
  await expect(emailField(appPage)).toBeHidden();
  expect(await readViewer(appPage)).toEqual(wwwViewer);

  // The cookie both tabs share is one Secure cookie scoped to the parent domain.
  const cookies = await sessionCookies(wwwPage);
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({ name: '__Secure-next-auth.session-token', secure: true, httpOnly: true });
  expect(cookies[0]?.domain).toBe(COOKIE_DOMAIN);

  await wwwPage.goto(`${WWW_ORIGIN}/auth/signout?callbackUrl=${encodeURIComponent('/')}`);
  await wwwPage.waitForURL((url) => !url.pathname.startsWith('/auth/signout'));
  expect((await readViewer(wwwPage)).authenticated).toBe(false);

  // The app tab learns of it on its next load and shows the sign-in form.
  await appPage.reload();
  await expect(emailField(appPage)).toBeVisible({ timeout: 120_000 });
  await expect(homeTab(appPage)).toBeHidden();
  expect((await readViewer(appPage)).authenticated).toBe(false);
  expect(await sessionCookies(wwwPage)).toHaveLength(0);
});
