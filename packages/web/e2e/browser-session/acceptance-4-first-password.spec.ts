import type { BrowserContext, Page } from '@playwright/test';
import { readViewer } from './helpers';
import { BRIDGED_COOKIE, WWW_ORIGIN, type SeededAccount } from './stack';
import { expect, sessionSetCookies, test, type FirstPasswordLink } from './fixtures';

/**
 * #7596 acceptance 4 for a first password on a BRIDGED session, under
 * AUTH_BROWSER_SESSION_MODE=better-auth with provider security and first
 * password staged (the run's own settings), in Chromium and WebKit.
 *
 * A climber whose only sign-in is Google, still on a pre-cutover cookie, asks
 * for a first password. The backend plans an email; www sends it through the
 * shared mailer, which in this run reaches the run's mail sink (mail-sink.ts),
 * never a real inbox. The spec reads the link there, as the climber would read
 * it in their inbox; nothing in the product is weakened for it.
 *
 * - Without the emailed link nothing completes: a made-up link is refused and
 *   no password is written.
 * - Another session of the same account (another browser, its own bridged
 *   cookie) presenting the real link changes nothing.
 * - The session that asked completes it on the link's page: it stays signed in
 *   with the same session id, no response sets or clears a session cookie, and
 *   the other session is signed out (the account's generation moved).
 *
 * The set-password card with provider security off stays in
 * acceptance-4-set-password.spec.ts.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const NEW_PASSWORD = 'a first password for this climber';
const DONE = 'Your password is set. You can now sign in with your email and password.';
const OTHER_BROWSER = 'Open this link in the browser where you asked for it. Nothing has changed.';
const FLOW_COOKIE = '__Host-boardsesh.first-password-flow';

type Viewer = Awaited<ReturnType<typeof readViewer>>;

/** A pre-cutover cookie for `account` in `context`, bridged by the first page load; returns the page and its viewer. */
async function bridgedPage(
  context: BrowserContext,
  account: SeededAccount,
  addLegacy: (context: BrowserContext, account: SeededAccount) => Promise<{ authSessionId: string }>,
): Promise<{ page: Page; viewer: Viewer }> {
  const minted = await addLegacy(context, account);
  const page = await context.newPage();
  await page.goto(`${WWW_ORIGIN}/settings`);
  await expect
    .poll(async () => (await context.cookies()).some((cookie) => cookie.name === BRIDGED_COOKIE), { timeout: 20_000 })
    .toBe(true);
  const viewer = await readViewer(page);
  expect(viewer).toEqual({ authenticated: true, userId: account.userId, authSessionId: minted.authSessionId });
  return { page, viewer };
}

/** One first-password step from the page, as the Settings card and the link's page send it. */
async function postFirstPassword(page: Page, step: string, body: Record<string, unknown>, viewer: Viewer) {
  return page.evaluate(
    async ({ origin, path, payload, expectedViewer }) => {
      const response = await fetch(`${origin}/api/auth/first-password/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'X-Boardsesh-Expected-Viewer': expectedViewer },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
    },
    { origin: WWW_ORIGIN, path: step, payload: body, expectedViewer: `${viewer.userId}:${viewer.authSessionId}` },
  );
}

const linkUrl = ({ token, operation }: FirstPasswordLink) =>
  `${WWW_ORIGIN}/auth/confirm-first-password#${new URLSearchParams({ token, operation }).toString()}`;

test('first password on a bridged session: only the emailed link completes it, only in the session that asked', async ({
  context,
  openContext,
  freshAccount,
  accountDatabase,
  legacySession,
  edgeCookies,
  mailbox,
}, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-bfcache', 'Runs in chromium and webkit.');
  const account = accountDatabase.firstPasswordAccount(freshAccount());
  const addLegacy = (target: BrowserContext, owner: SeededAccount) => legacySession.addTo(target, owner, 'normal');
  const asker = await bridgedPage(context, account, addLegacy);
  const other = await bridgedPage(await openContext(), account, addLegacy);
  expect(other.viewer.authSessionId).not.toBe(asker.viewer.authSessionId);

  // The bridged session asks: an email goes out and the flow is bound to this browser, no session cookie.
  const requested = await edgeCookies.during(() => postFirstPassword(asker.page, 'request', {}, asker.viewer));
  expect(requested.result).toMatchObject({ status: 200, body: { status: 'sent' } });
  expect(sessionSetCookies(requested.records)).toEqual([]);
  expect(requested.records.flatMap((record) => record.setCookies.map((cookie) => cookie.name))).toContain(FLOW_COOKIE);

  // Without the emailed link nothing completes.
  const guessed = await postFirstPassword(
    asker.page,
    'confirm',
    { token: 'A'.repeat(43), operation: '0'.repeat(64), password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    asker.viewer,
  );
  expect(guessed.status).toBe(409);
  expect(accountDatabase.hasPassword(account)).toBe(false);

  const link = await mailbox.firstPasswordLink(account.email);
  expect(await mailbox.count(account.email)).toBe(1);

  // Another session of the account presenting the real link changes nothing.
  const elsewhere = await edgeCookies.during(async () => {
    await other.page.goto(linkUrl(link));
    await expect(other.page.getByText(OTHER_BROWSER)).toBeVisible({ timeout: 30_000 });
    return postFirstPassword(
      other.page,
      'confirm',
      { ...link, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      other.viewer,
    );
  });
  expect(elsewhere.result.status).toBe(409);
  expect(sessionSetCookies(elsewhere.records)).toEqual([]);
  expect(accountDatabase.hasPassword(account)).toBe(false);
  expect(await readViewer(other.page)).toEqual(other.viewer);

  // The session that asked completes it on the link's page.
  const consentPrompt = asker.page.getByRole('button', { name: 'No thanks', exact: true });
  await asker.page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
  });
  const completed = await edgeCookies.during(async () => {
    await asker.page.goto(linkUrl(link));
    await asker.page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await asker.page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await asker.page.getByRole('button', { name: 'Save password' }).click();
    await expect(asker.page.getByText(DONE)).toBeVisible({ timeout: 30_000 });
  });
  expect(sessionSetCookies(completed.records)).toEqual([]);
  expect(accountDatabase.hasPassword(account)).toBe(true);
  // Same session, still signed in.
  expect(await readViewer(asker.page)).toEqual(asker.viewer);
  // The other session is signed out.
  await expect.poll(async () => (await readViewer(other.page)).authenticated, { timeout: 30_000 }).toBe(false);
});
