import type { Page } from '@playwright/test';
import { expectSessionReadNames, isSameDocument, markDocument, readViewer, signInOnWww } from './helpers';
import { BRIDGED_COOKIE, WWW_HOST, WWW_ORIGIN } from './stack';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 4, under AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium
 * and WebKit, through the Settings set-password card a climber uses:
 *
 * - On a bridged session (a pre-cutover cookie) set-password asks for a new
 *   sign-in and sets nothing: a bridged session never counts as fresh.
 * - On a fresh login it succeeds, the tab stays signed in on the same session
 *   with no reload and no session Set-Cookie, and another browser signed in to
 *   the same account is signed out (set-password ends every other session).
 *
 * That card is what Settings shows while provider security is off. With
 * `CURRENT_STORE_PROVIDER_SECURITY_MODE=backend-staging`, as the rest of this
 * run has it, Settings shows the sign-in methods card instead, whose path to a
 * first password is the emailed first-password flow, and the backend answers
 * every set-password `reauthentication_required` by design (set-password.ts).
 * So this spec restarts both servers with provider security and first password
 * off, and back afterwards. The accounts have their password row removed first,
 * as climbers who only ever signed in with Google; a new password is the
 * account's own again.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');
test.describe.configure({ timeout: 900_000 });

const PASSWORD_SET = 'Password set! You can now log in with your email and password.';
const SIGN_IN_AGAIN = 'Sign in again to set a password.';
const SET_PASSWORD_CARD = {
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'legacy',
  CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy',
};

async function submitPassword(page: Page, password: string): Promise<void> {
  // A signed-in account may be asked once about analytics; the prompt can sit over the form.
  const consentPrompt = page.getByRole('button', { name: 'No thanks', exact: true });
  await page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
  });
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm Password').fill(password);
  await page.getByRole('button', { name: 'Set Password' }).click();
}

test('set-password asks a bridged session to sign in again; on a fresh login it sets, with no reload or cookie, and signs the other browser out', async ({
  page,
  openContext,
  freshAccount,
  accountDatabase,
  legacySession,
  edgeCookies,
  restartStack,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  await restartStack({ env: SET_PASSWORD_CARD });
  try {
    // A bridged session: refused, nothing written.
    const bridgedAccount = freshAccount();
    accountDatabase.removePassword(bridgedAccount);
    const bridgedPage = await (await openContext()).newPage();
    const minted = await legacySession.addTo(bridgedPage.context(), bridgedAccount, 'normal');
    await bridgedPage.goto(`${WWW_ORIGIN}/settings`);
    // The page's own first read bridges; wait for it so the window below holds only set-password.
    await expect
      .poll(async () => (await bridgedPage.context().cookies()).some((cookie) => cookie.name === BRIDGED_COOKIE), {
        timeout: 20_000,
      })
      .toBe(true);
    const attempt = await edgeCookies.during(async () => {
      await submitPassword(bridgedPage, bridgedAccount.password);
      await expect(bridgedPage.getByText(SIGN_IN_AGAIN)).toBeVisible({ timeout: 30_000 });
    });
    const refused = attempt.records.find(
      (record) => record.host === WWW_HOST && record.path === '/api/internal/set-password',
    );
    expect(refused?.status).toBe(403);
    expect(sessionSetCookies(attempt.records)).toEqual([]);
    await expect(bridgedPage.getByText(PASSWORD_SET)).toHaveCount(0);
    expect(await readViewer(bridgedPage)).toMatchObject({
      userId: bridgedAccount.userId,
      authSessionId: minted.authSessionId,
    });

    // A fresh login: set, same tab and session, no cookie, the other browser signed out.
    const account = freshAccount();
    const otherBrowser = await (await openContext()).newPage();
    await signInOnWww(otherBrowser, account);
    await expectSessionReadNames(otherBrowser, account);
    await signInOnWww(page, account);
    await expectSessionReadNames(page, account);
    accountDatabase.removePassword(account);
    const before = await readViewer(page);
    await page.goto(`${WWW_ORIGIN}/settings`);
    await markDocument(page);
    const change = await edgeCookies.during(async () => {
      await submitPassword(page, account.password);
      await expect(page.getByText(PASSWORD_SET)).toBeVisible({ timeout: 30_000 });
    });
    const set = change.records.find(
      (record) => record.host === WWW_HOST && record.path === '/api/internal/set-password',
    );
    expect(set?.status).toBe(200);
    expect(sessionSetCookies(change.records)).toEqual([]);
    expect(await isSameDocument(page)).toBe(true);
    expect(await readViewer(page)).toEqual(before);
    await expect.poll(async () => (await readViewer(otherBrowser)).authenticated, { timeout: 30_000 }).toBe(false);
  } finally {
    await restartStack();
  }
});
