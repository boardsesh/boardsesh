import type { Page } from '@playwright/test';
import { isSameDocument, markDocument, readViewer, signInOnWww, expectSessionReadNames } from './helpers';
import { WWW_HOST, WWW_ORIGIN } from './stack';
import { expect, failsOnSessionReadGrant, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 4, under AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium
 * and WebKit, through the Settings card a climber uses:
 *
 * - On a bridged session (a pre-cutover cookie) set-password asks for a new
 *   sign-in and sets nothing: a bridged session never counts as fresh.
 * - On a fresh login it succeeds, the tab stays signed in on the same session
 *   with no reload and no session Set-Cookie, and another browser signed in to
 *   the same account is signed out (set-password ends every other session).
 *
 * The account has its password row removed first, as a climber who only ever
 * signed in with Google; the new password is the account's own again.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const PASSWORD_SET = 'Password set! You can now log in with your email and password.';
const SIGN_IN_AGAIN = 'Sign in again to set a password.';

async function submitPassword(page: Page, password: string): Promise<void> {
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm Password').fill(password);
  await page.getByRole('button', { name: 'Set Password' }).click();
}

test('on a bridged session it asks for a new sign-in and sets nothing', async ({
  context,
  page,
  freshAccount,
  accountDatabase,
  legacySession,
  edgeCookies,
}) => {
  failsOnSessionReadGrant();
  const account = freshAccount();
  accountDatabase.removePassword(account);
  const minted = await legacySession.addTo(context, account, 'normal');
  await page.goto(`${WWW_ORIGIN}/settings`);
  await expect.poll(async () => (await readViewer(page)).authSessionId).toBe(minted.authSessionId);

  const attempt = await edgeCookies.during(async () => {
    await submitPassword(page, account.password);
    await expect(page.getByText(SIGN_IN_AGAIN)).toBeVisible({ timeout: 30_000 });
  });
  const reply = attempt.records.find(
    (record) => record.host === WWW_HOST && record.path === '/api/internal/set-password',
  );
  expect(reply?.status).toBe(403);
  expect(sessionSetCookies(attempt.records)).toEqual([]);
  await expect(page.getByText(PASSWORD_SET)).toHaveCount(0);
  // Still the bridged session.
  expect(await readViewer(page)).toMatchObject({ userId: account.userId, authSessionId: minted.authSessionId });
});

test('on a fresh login it succeeds with no reload and no cookie, and signs the other browser out', async ({
  page,
  openContext,
  freshAccount,
  accountDatabase,
  edgeCookies,
}) => {
  failsOnSessionReadGrant();
  const account = freshAccount();
  const otherBrowser = await (await openContext()).newPage();
  await signInOnWww(otherBrowser, account);
  await expectSessionReadNames(otherBrowser, account);
  await signInOnWww(page, account);
  await expectSessionReadNames(page, account);
  accountDatabase.removePassword(account);
  const before = await readViewer(page);
  expect((await readViewer(otherBrowser)).userId).toBe(account.userId);

  await page.goto(`${WWW_ORIGIN}/settings`);
  await markDocument(page);
  const change = await edgeCookies.during(async () => {
    await submitPassword(page, account.password);
    await expect(page.getByText(PASSWORD_SET)).toBeVisible({ timeout: 30_000 });
  });
  const reply = change.records.find(
    (record) => record.host === WWW_HOST && record.path === '/api/internal/set-password',
  );
  expect(reply?.status).toBe(200);
  expect(sessionSetCookies(change.records)).toEqual([]);

  // Same tab, same document, same session.
  expect(await isSameDocument(page)).toBe(true);
  expect(await readViewer(page)).toEqual(before);
  // The other browser's session ended.
  await expect.poll(async () => (await readViewer(otherBrowser)).authenticated, { timeout: 30_000 }).toBe(false);
});
