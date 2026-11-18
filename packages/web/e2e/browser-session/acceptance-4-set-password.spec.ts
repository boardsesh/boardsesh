import type { Page } from '@playwright/test';
import { isSameDocument, markDocument, readViewer, signInOnWww, expectSessionReadNames } from './helpers';
import { WWW_ORIGIN } from './stack';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 4, under AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium
 * and WebKit, through the request the Settings set-password card sends:
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

/**
 * The Settings card's request (`set-password-section.tsx`): the guard's expected-viewer header
 * and the expected login in the body. With provider security staged on www, as here, Settings
 * shows the sign-in methods card and its first-password flow instead of that card, so the
 * route is driven from the page as the card drives it; the page and its guard stay loaded.
 */
async function setPassword(page: Page, password: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { userId, authSessionId } = await readViewer(page);
  return page.evaluate(
    async ({ origin, expected, chosen }) => {
      const response = await fetch(`${origin}/api/internal/set-password`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'X-Boardsesh-Expected-Viewer': `${expected.userId}:${expected.authSessionId}`,
        },
        body: JSON.stringify({
          password: chosen,
          confirmPassword: chosen,
          expectedUserId: expected.userId,
          expectedAuthSessionId: expected.authSessionId,
        }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { origin: WWW_ORIGIN, expected: { userId: userId ?? '', authSessionId: authSessionId ?? '' }, chosen: password },
  );
}

test('on a bridged session it asks for a new sign-in and sets nothing', async ({
  context,
  page,
  freshAccount,
  accountDatabase,
  legacySession,
  edgeCookies,
}) => {
  const account = freshAccount();
  accountDatabase.removePassword(account);
  const minted = await legacySession.addTo(context, account, 'normal');
  await page.goto(`${WWW_ORIGIN}/settings`);
  await expect.poll(async () => (await readViewer(page)).authSessionId).toBe(minted.authSessionId);

  const attempt = await edgeCookies.during(() => setPassword(page, account.password));
  expect(attempt.result).toEqual({
    status: 403,
    body: expect.objectContaining({ error: 'reauthentication_required' }),
  });
  expect(sessionSetCookies(attempt.records)).toEqual([]);
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
  const change = await edgeCookies.during(() => setPassword(page, account.password));
  expect(change.result).toEqual({ status: 200, body: { outcome: 'set' } });
  expect(sessionSetCookies(change.records)).toEqual([]);

  // Same tab, same document, same session.
  expect(await isSameDocument(page)).toBe(true);
  expect(await readViewer(page)).toEqual(before);
  // The other browser's session ended.
  await expect.poll(async () => (await readViewer(otherBrowser)).authenticated, { timeout: 30_000 }).toBe(false);
});
