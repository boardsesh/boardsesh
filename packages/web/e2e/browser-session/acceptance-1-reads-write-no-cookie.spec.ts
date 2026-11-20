import {
  fetchWsAuth,
  openApp,
  readSession,
  readViewer,
  signInOnWww,
  signOutOnWww,
  expectSessionReadNames,
} from './helpers';
import {
  APP_ORIGIN,
  BRIDGED_COOKIE,
  COOKIE_DOMAIN,
  LOGIN_COOKIE,
  MARKER_COOKIE,
  WWW_HOST,
  WWW_ORIGIN,
  type SetCookieRecord,
} from './stack';
import { expect, expectedMarker, markerSetCookies, sessionSetCookies, test } from './fixtures';

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
 *
 * The viewer marker (#7596 decision, "how the guard learns of an account
 * switch on another host") rides only with those writes: the login, the
 * bridging read and the sign-out carry it, with the login's value and the
 * session cookie's scope, readable by page scripts on www and the app; nothing
 * else writes or clears it.
 */

/** The marker's attributes: the session cookie's scope, and never HttpOnly. */
function expectMarkerAttributes(attributes: readonly string[]): void {
  expect(attributes).toEqual(
    expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Path=/', 'Secure', 'SameSite=Lax', 'Max-Age=34560000']),
  );
  expect(attributes).not.toContain('HttpOnly');
}

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
  if (!viewer.authSessionId) throw new Error('No session id after sign-in.');
  // The login writes the marker for its own session, readable by page scripts.
  const marker = expectedMarker(viewer.authSessionId);
  const markerWrites = markerSetCookies(signIn.records).filter((cookie) => !cookie.clears);
  expect(markerWrites).toEqual([
    expect.objectContaining({
      host: WWW_HOST,
      path: '/api/auth/callback/credentials',
      name: MARKER_COOKIE,
      valueDigest: marker.valueDigest,
    }),
  ]);
  expectMarkerAttributes(markerWrites[0]?.attributes ?? []);
  expect(await page.evaluate(() => document.cookie)).toContain(`${MARKER_COOKIE}=${marker.value}`);
  expect(markerSetCookies(signIn.records).filter((cookie) => cookie.path !== '/api/auth/callback/credentials')).toEqual(
    [],
  );

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
        // With the guard's expected-viewer header, as Settings sends them, so each reaches the backend.
        const guarded = { 'content-type': 'application/json', 'X-Boardsesh-Expected-Viewer': expectedViewer };
        await fetch(`${origin}/api/auth/provider-security/methods`, {
          ...include,
          headers: { 'X-Boardsesh-Expected-Viewer': expectedViewer },
        });
        await fetch(`${origin}/api/auth/provider-security/start`, {
          ...include,
          method: 'POST',
          headers: guarded,
          body: JSON.stringify({ action: 'unlink', provider: 'google', methodId: null }),
        });
        await fetch(`${origin}/api/auth/first-password/request`, {
          ...include,
          method: 'POST',
          headers: guarded,
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
    // The app host reads the parent-domain marker www wrote.
    expect(await appPage.evaluate(() => document.cookie)).toContain(`${MARKER_COOKIE}=${marker.value}`);
    expect(new URL(appPage.url()).origin).toBe(APP_ORIGIN);
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
  expect(markerSetCookies(reads.records)).toEqual([]);
  // Still the same login after all of it.
  expect(await readViewer(page)).toEqual(viewer);

  // Sign-out clears the marker in both scopes with the session cookies, and writes none.
  const signOut = await edgeCookies.during(() => signOutOnWww(page));
  const markerClears = markerSetCookies(signOut.records);
  expect(markerClears.every((cookie) => cookie.clears && cookie.path === '/api/auth/signout')).toBe(true);
  expect(markerClears.some((cookie) => cookie.attributes.includes(`Domain=${COOKIE_DOMAIN}`))).toBe(true);
  expect(markerClears.some((cookie) => !cookie.attributes.some((attribute) => attribute.startsWith('Domain=')))).toBe(
    true,
  );
  expect((await context.cookies(WWW_ORIGIN)).some((cookie) => cookie.name === MARKER_COOKIE)).toBe(false);
});

test('@smoke only the session read that bridges a pre-cutover cookie writes, and only the bridged cookie', async ({
  context,
  page,
  freshAccount,
  legacySession,
  edgeCookies,
  accountDatabase,
}) => {
  const account = freshAccount();
  const minted = await legacySession.addTo(context, account, 'normal');
  const hasBridgedCookie = async () => (await context.cookies()).some((cookie) => cookie.name === BRIDGED_COOKIE);
  // The page's own session reads, and nothing of the spec's, until the browser holds the bridged cookie.
  const bridging = await edgeCookies.during(async () => {
    await page.goto(`${WWW_ORIGIN}/settings`);
    await expect.poll(hasBridgedCookie, { timeout: 20_000 }).toBe(true);
  });
  const writes = sessionSetCookies(bridging.records);
  // Reads that left before the first answer landed each bridge, to the same token by design
  // (owner decision 3); each writes the bridged cookie and nothing else.
  expect(writes.length).toBeGreaterThan(0);
  // Every write carries the same bridged token (deterministic, owner decision 3).
  expect(new Set(writes.map((cookie) => cookie.valueDigest)).size).toBe(1);
  for (const cookie of writes) {
    expect(cookie).toMatchObject({ host: WWW_HOST, path: '/api/auth/session', name: BRIDGED_COOKIE, clears: false });
    expect(cookie.attributes).toEqual(
      expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']),
    );
  }
  for (const record of bridging.records.filter((entry) => sessionSetCookies([entry]).length > 0))
    expect(`${record.method} ${record.path}`).toBe('GET /api/auth/session');
  // Each bridging write carries the marker for the bridged login (the legacy cookie's session id).
  const marker = expectedMarker(minted.authSessionId);
  const markerWrites = markerSetCookies(bridging.records).filter((cookie) => !cookie.clears);
  expect(markerWrites.length).toBe(writes.length);
  // Beside each write, only a clear of a host-only marker copy (the other scope), never of the Domain one.
  for (const clear of markerSetCookies(bridging.records).filter((cookie) => cookie.clears))
    expect(clear.attributes.some((attribute) => attribute.startsWith('Domain='))).toBe(false);
  for (const cookie of markerWrites) {
    expect(cookie).toMatchObject({
      host: WWW_HOST,
      path: '/api/auth/session',
      name: MARKER_COOKIE,
      clears: false,
      valueDigest: marker.valueDigest,
    });
    expectMarkerAttributes(cookie.attributes);
  }

  // Once the browser holds it, no read writes anything, the legacy cookie stays.
  const after = await edgeCookies.during(async () => {
    await page.reload();
    await readSession(page);
    await readViewer(page);
  });
  expect(sessionSetCookies(after.records)).toEqual([]);
  expect(markerSetCookies(after.records)).toEqual([]);
  // A bridged session cannot set a password here: with provider security on, set-password refuses
  // everyone (set-password.ts); first password is the way, acceptance-4-first-password.spec.ts.
  // Without a password row, so the refusal is that and not "already set" (409).
  accountDatabase.removePassword(account);
  const bridgedViewer = await readViewer(page);
  const refusal = await edgeCookies.during(() =>
    page.evaluate(
      async ({ origin, userId, authSessionId }) => {
        // The Settings card's request: the guard's header and the expected login in the body.
        const response = await fetch(`${origin}/api/internal/set-password`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'X-Boardsesh-Expected-Viewer': `${userId}:${authSessionId}` },
          body: JSON.stringify({
            password: 'a password of eight',
            confirmPassword: 'a password of eight',
            expectedUserId: userId,
            expectedAuthSessionId: authSessionId,
          }),
        });
        return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
      },
      { origin: WWW_ORIGIN, userId: bridgedViewer.userId, authSessionId: bridgedViewer.authSessionId },
    ),
  );
  expect(refusal.result).toEqual({ status: 403, body: { error: 'reauthentication_required' } });
  expect(accountDatabase.hasPassword(account)).toBe(false);
  expect(sessionSetCookies(refusal.records)).toEqual([]);
  expect(markerSetCookies(refusal.records)).toEqual([]);
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
  expect(markerSetCookies(rolled.records)).toEqual([]);

  const renewed = accountDatabase.sessionExpiry(account, authSessionId);
  if (!renewed) throw new Error('The rolled session row is gone.');
  // Rolled to the last roll plus 30 days: about two days later than the aged expiry.
  expect(renewed.getTime() - aged.getTime()).toBeGreaterThan(36 * 3_600_000);
  expect(await readViewer(page)).toMatchObject({ authenticated: true, userId: account.userId, authSessionId });
});
