import type { Page } from '@playwright/test';
import { APP_ORIGIN, COOKIE_DOMAIN, TEST_USER_EMAIL, TEST_USER_PASSWORD, WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * Baseline, today's mode (`AUTH_BROWSER_SESSION_MODE` unset, NextAuth): one
 * browser context signs in on www, and the app subdomain, which never saw a
 * password, is signed in as the same account because the `Domain=.boardsesh.test`
 * session cookie rides its credentialed calls to www. Signing out on www signs
 * the app out. The Phase B specs run the same shape against `better-auth`.
 */

interface WsAuthRead {
  authenticated: boolean;
  userId?: string;
  authSessionId?: string;
}

test.skip(
  !!process.env.AUTH_BROWSER_SESSION_MODE,
  'The baseline runs in legacy mode; AUTH_BROWSER_SESSION_MODE is set for this run.',
);

/** The viewer www's cookie route answers for, called from the page's own origin or cross-origin from the app. */
async function readViewer(page: Page): Promise<WsAuthRead> {
  return page.evaluate(async (wwwOrigin) => {
    const response = await fetch(`${wwwOrigin}/api/internal/ws-auth`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const { authenticated, userId, authSessionId } = (await response.json()) as WsAuthRead;
    return { authenticated, userId, authSessionId };
  }, WWW_ORIGIN);
}

async function signInOnWww(page: Page): Promise<void> {
  await page.goto(`${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent('/settings')}`);
  await page.getByLabel('Email').fill(TEST_USER_EMAIL);
  await page.getByLabel('Password').fill(TEST_USER_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(`${WWW_ORIGIN}/settings`);
}

/** Opens the app and declines the one-time analytics question a fresh account may be asked. */
async function openApp(page: Page): Promise<void> {
  const consentPrompt = page.getByRole('button', { name: 'No thanks', exact: true });
  await page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
  });
  await page.goto(`${APP_ORIGIN}/`);
}

const homeTab = (page: Page) => page.getByRole('tab', { name: 'Home', exact: true });
const emailField = (page: Page) => page.getByRole('textbox', { name: 'Email', exact: true });
const sessionCookies = async (page: Page) =>
  (await page.context().cookies()).filter((cookie) => cookie.name.endsWith('next-auth.session-token'));

test('the app subdomain follows the www sign-in and sign-out', async ({ context }) => {
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage);
  const wwwViewer = await readViewer(wwwPage);
  expect(wwwViewer.authenticated).toBe(true);
  expect(wwwViewer.userId).toBeTruthy();

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
