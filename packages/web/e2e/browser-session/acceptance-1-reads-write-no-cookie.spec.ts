import { fetchWsAuth, openApp, readSession, readViewer, signInOnWww, expectSessionReadNames } from './helpers';
import { BRIDGED_COOKIE, COOKIE_DOMAIN, LOGIN_COOKIE, WWW_HOST, WWW_ORIGIN, type SetCookieRecord } from './stack';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 1, under AUTH_BROWSER_SESSION_MODE=better-auth, in Chromium
 * and WebKit: only login and sign-out responses write the session cookie.
 * Session reads (GET and POST), csrf, ws-auth, server-rendered private pages
 * and set-password emit no session Set-Cookie of any name: login, bridged or
 * legacy, chunks included. The one documented exception is the session read
 * that bridges a pre-cutover cookie, which writes exactly the bridged cookie.
 * A session with under 29 days left rolls on the server, through ws-auth's
 * access command, and writes no cookie either.
 *
 * The Settings routes for provider link, unlink and reauthentication and for
 * a first password (#7804 to #7809) are in the list too: they act for the
 * session and keep its token, so they write no session cookie either.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

/** Every request the spec asked for reached the edge, so "no Set-Cookie" is not "never ran". */
function expectRequested(records: readonly SetCookieRecord[], method: string, path: string): void {
  expect(
    records.some((record) => record.host === WWW_HOST && record.method === method && record.path === path),
    `${method} ${path} reached www`,
  ).toBe(true);
}

test('@smoke session reads, csrf, ws-auth, private pages and set-password write no session cookie', async ({
  context,
  page,
  freshAccount,
  edgeCookies,
}) => {
  const account = freshAccount();
  const signIn = await edgeCookies.during(() => signInOnWww(page, account));
  await expectSessionReadNames(page, account);
  // The login writes the login cookie, and nothing else in the sign-in writes a session cookie.
  const signInWrites = sessionSetCookies(signIn.records).filter((cookie) => !cookie.clears);
  expect(signInWrites).toContainEqual(
    expect.objectContaining({ host: WWW_HOST, path: '/api/auth/callback/credentials', name: LOGIN_COOKIE }),
  );
  expect(signInWrites.filter((cookie) => cookie.path !== '/api/auth/callback/credentials')).toEqual([]);
  const login = signInWrites.find((cookie) => cookie.name === LOGIN_COOKIE);
  expect(login?.attributes).toEqual(
    expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']),
  );
  const viewer = await readViewer(page);
  expect(viewer.userId).toBe(account.userId);

  const reads = await edgeCookies.during(async () => {
    // Server renders of private pages, each a full document.
    await page.goto(`${WWW_ORIGIN}/settings`);
    await page.goto(`${WWW_ORIGIN}/profile/${account.userId}`);
    await page.goto(`${WWW_ORIGIN}/settings`);
    await page.evaluate(
      async ({ origin, expectedViewer }) => {
        const include = { credentials: 'include' as const, cache: 'no-store' as const };
        await fetch(`${origin}/api/auth/session`, include);
        const { csrfToken } = (await (await fetch(`${origin}/api/auth/csrf`, include)).json()) as { csrfToken: string };
        await fetch(`${origin}/api/auth/session`, {
          ...include,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrfToken }),
        });
        await fetch(`${origin}/api/internal/ws-auth`, include);
        // Settings' provider and first-password routes (#7804, #7805, #7807, #7809). Each acts for the
        // session and keeps its token: whatever each answers here, none may write a session cookie.
        await fetch(`${origin}/api/auth/provider-security/methods`, include);
        await fetch(`${origin}/api/auth/provider-security/start`, {
          ...include,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'unlink', provider: 'google', methodId: null }),
        });
        await fetch(`${origin}/api/auth/first-password/request`, {
          ...include,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        // This account has a password, so the backend refuses; what matters is the cookie list.
        await fetch(`${origin}/api/internal/set-password`, {
          ...include,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Boardsesh-Expected-Viewer': expectedViewer },
          body: JSON.stringify({ password: 'another password 1', confirmPassword: 'another password 1' }),
        });
      },
      { origin: WWW_ORIGIN, expectedViewer: `${viewer.userId}:${viewer.authSessionId}` },
    );
    // The app subdomain's own session reads go to www too.
    const appPage = await context.newPage();
    await openApp(appPage);
    await expect.poll(async () => (await readViewer(appPage)).userId).toBe(account.userId);
  });

  for (const [method, path] of [
    ['GET', '/settings'],
    ['GET', `/profile/${account.userId}`],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/session'],
    ['GET', '/api/auth/csrf'],
    ['GET', '/api/internal/ws-auth'],
    ['POST', '/api/internal/set-password'],
    ['GET', '/api/auth/provider-security/methods'],
    ['POST', '/api/auth/provider-security/start'],
    ['POST', '/api/auth/first-password/request'],
  ] as const)
    expectRequested(reads.records, method, path);
  expect(sessionSetCookies(reads.records)).toEqual([]);
  // Still the same login after all of it.
  expect(await readViewer(page)).toEqual(viewer);
});

test('@smoke the session read that bridges a pre-cutover cookie writes exactly the bridged cookie, once', async ({
  context,
  page,
  freshAccount,
  legacySession,
  edgeCookies,
}) => {
  const account = freshAccount();
  const minted = await legacySession.addTo(context, account, 'normal');
  const window = await edgeCookies.during(async () => {
    await page.goto(`${WWW_ORIGIN}/settings`);
    await expect.poll(async () => (await readSession(page)).userId).toBe(account.userId);
    await page.reload();
    await readSession(page);
    await readViewer(page);
  });
  const writes = sessionSetCookies(window.records);
  expect(writes).toEqual([
    expect.objectContaining({ host: WWW_HOST, path: '/api/auth/session', name: BRIDGED_COOKIE, clears: false }),
  ]);
  expect(writes[0]?.attributes).toEqual(
    expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']),
  );
  // The bridged session keeps the legacy cookie's session id.
  expect(await readViewer(page)).toEqual({
    authenticated: true,
    userId: account.userId,
    authSessionId: minted.authSessionId,
  });
});

test('a session with under 29 days left rolls on the server and writes no cookie', async ({
  page,
  freshAccount,
  edgeCookies,
  accountDatabase,
}) => {
  const account = freshAccount();
  await signInOnWww(page, account);
  await expectSessionReadNames(page, account);
  const { authSessionId } = await readViewer(page);
  if (!authSessionId) throw new Error('No session id after sign-in.');
  accountDatabase.ageSession(account, authSessionId, 28);
  const aged = accountDatabase.sessionExpiry(account, authSessionId);
  if (!aged) throw new Error('The aged session row is gone.');

  // ws-auth's access command is the one place a session rolls (B3a).
  const rolled = await edgeCookies.during(() => fetchWsAuth(page));
  expect(rolled.result).toMatchObject({ status: 200, authenticated: true, authSessionId });
  expect(sessionSetCookies(rolled.records)).toEqual([]);

  const renewed = accountDatabase.sessionExpiry(account, authSessionId);
  if (!renewed) throw new Error('The rolled session row is gone.');
  // Rolled to the last roll plus 30 days: about two days later than the aged expiry.
  expect(renewed.getTime() - aged.getTime()).toBeGreaterThan(36 * 3_600_000);
  expect(await readViewer(page)).toMatchObject({ authenticated: true, userId: account.userId, authSessionId });
});
