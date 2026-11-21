import { createHash, randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import {
  continueWithApple,
  expectSessionReadNames,
  postCredentialsLogin,
  readSession,
  readViewer,
  signInOnWww,
} from './helpers';
import {
  APP_ORIGIN,
  BRIDGED_COOKIE,
  LOGIN_COOKIE,
  MARKER_COOKIE,
  WWW_HOST,
  WWW_ORIGIN,
  type SetCookieRecord,
} from './stack';
import { expect, expectedMarker, sessionSetCookies, test, type ResponseHoldsFixture } from './fixtures';

/**
 * #7596 B7c: the cookie-order fixture of docs/auth/better-auth-browser-cookie-order.md,
 * rerun on this design in Chromium and WebKit, on the real routes and real
 * backend under AUTH_BROWSER_SESSION_MODE=better-auth.
 *
 * The question it asks: when a browser holds copies of a session cookie in
 * more than one scope, or two responses that write one race, which one wins,
 * and can any order leave the browser on the WRONG account? The design's
 * answers, each checked here in both engines:
 *
 * - Only logins and sign-out write the session cookie; reads, renewal and the
 *   token never do. A login reply that arrives last wins, as the owner
 *   accepted (#7596, "What choosing this accepts", item 1): the browser ends
 *   on that login and the other tab's login is gone; no data crosses.
 * - Two differing copies of one name (Domain and host-only) read as
 *   conflicted: signed out, never one of them. A login clears the host-only copy.
 * - A login cookie outranks a bridged one, whichever reply landed last.
 * - Apple: a held Apple sign-in reply landing after a later login is the
 *   same accepted last-login-wins outcome, and passes.
 *
 * The edge (partner-oauth-e2e/edge.ts) holds a reply after the server
 * answered it, so the browser stores its Set-Cookie only on release, as a
 * slow network would deliver it. Each case logs one `[cookie-order]` line
 * with the engine and what the browser ended with.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

const CREDENTIALS_CALLBACK = '/api/auth/callback/credentials';

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Every copy of a cookie the context holds for www, with its scope. */
async function copiesOf(context: BrowserContext, name: string) {
  return (await context.cookies(WWW_ORIGIN))
    .filter((cookie) => cookie.name === name)
    .map((cookie) => ({ hostOnly: !cookie.domain.startsWith('.'), digest: digestOf(cookie.value) }));
}

/** The login cookie digest a window's reply wrote, if it wrote one. */
function loginWrite(records: readonly SetCookieRecord[], path: string): string | undefined {
  return sessionSetCookies(records).find(
    (cookie) => cookie.name === LOGIN_COOKIE && cookie.path === path && !cookie.clears,
  )?.valueDigest;
}

/** The browser holds exactly one login cookie, Domain-scoped, with this digest, and the marker for `authSessionId`. */
async function expectSingleLogin(context: BrowserContext, digest: string | undefined, authSessionId: string | null) {
  expect(digest, 'the reply wrote a login cookie').toBeTruthy();
  expect(await copiesOf(context, LOGIN_COOKIE)).toEqual([{ hostOnly: false, digest }]);
  if (authSessionId === null) return;
  const markers = await copiesOf(context, MARKER_COOKIE);
  expect(markers).toEqual([{ hostOnly: false, digest: expectedMarker(authSessionId).valueDigest }]);
}

/**
 * Runs `read` in `page`, again after a reload when the page's own guard
 * replaced its document meanwhile (the app reloads on an account change; that
 * is the design, not this spec's subject).
 */
async function onPage<T>(page: Page, read: (page: Page) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read(page);
    } catch (error) {
      if (
        attempt >= 3 ||
        !(error instanceof Error) ||
        !/Execution context was destroyed|navigation/i.test(error.message)
      )
        throw error;
      await page.waitForLoadState('load').catch(() => undefined);
    }
  }
}

/** The account both hosts read for this browser: www's session read and ws-auth, from www and from the app. */
async function expectBrowserReads(wwwPage: Page, appPage: Page, account: { userId: string }) {
  const session = await onPage(wwwPage, readSession);
  expect(session).toMatchObject({ status: 200, userId: account.userId });
  expect(await onPage(wwwPage, readViewer)).toMatchObject({ authenticated: true, userId: account.userId });
  expect(await onPage(appPage, readViewer)).toMatchObject({ authenticated: true, userId: account.userId });
  return session.authSessionId;
}

/**
 * A www document that runs no Boardsesh script (csrf's JSON), so requests made
 * from it are www's own and no session guard reloads it mid-test.
 */
async function wwwDocument(page: Page): Promise<Page> {
  await page.goto(`${WWW_ORIGIN}/api/auth/csrf`);
  return page;
}

/** A tab on the app host, used as an origin to log in from (a cross-subdomain login, as the app's form sends it). */
async function appOrigin(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'commit' });
  return page;
}

function report(engine: string, scenario: string, outcome: Record<string, unknown>) {
  console.info(`[cookie-order] engine=${engine} case=${scenario} ${JSON.stringify(outcome)}`);
}

test("two logins in two tabs: A's reply arrives after B's, so the browser ends on A and B is signed out", async ({
  context,
  freshAccount,
  responseHolds,
  edgeCookies,
  browserName,
}) => {
  const accountA = freshAccount();
  const accountB = freshAccount();
  const wwwPage = await wwwDocument(await context.newPage());
  const appPage = await appOrigin(context);

  const window = await edgeCookies.begin();
  const held = await responseHolds.arm({ host: WWW_HOST, method: 'POST', path: CREDENTIALS_CALLBACK });
  // A's login is answered (its session issued) and held on the way back.
  const loginA = postCredentialsLogin(wwwPage, accountA);
  await held.untilHeld();
  // B logs in from the app host meanwhile, and the browser stores B's cookies.
  expect(await postCredentialsLogin(appPage, accountB)).toBe(200);
  expect(await onPage(wwwPage, readSession)).toMatchObject({ status: 200, userId: accountB.userId });
  const records = await window.end();
  const loginB = loginWrite(records, CREDENTIALS_CALLBACK);
  expect(await copiesOf(context, LOGIN_COOKIE)).toEqual([{ hostOnly: false, digest: loginB }]);

  const late = await edgeCookies.begin();
  await held.release();
  expect(await loginA).toBe(200);
  const lateRecords = await late.end();
  const loginADigest = loginWrite(lateRecords, CREDENTIALS_CALLBACK);
  expect(loginADigest).not.toBe(loginB);

  // Last login wins: A, on both hosts; B's login cookie is gone and nothing names B.
  const authSessionId = await expectBrowserReads(wwwPage, appPage, accountA);
  await expectSingleLogin(context, loginADigest, authSessionId);
  report(browserName, 'two-logins', { finalAccount: 'A', loginCopies: 1, bStillHeld: false });
});

test('a held session read, renewal or token reply landing after a login writes nothing: the login stays', async ({
  context,
  freshAccount,
  responseHolds,
  edgeCookies,
  browserName,
}) => {
  const accountA = freshAccount();
  const accountB = freshAccount();
  const wwwPage = await context.newPage();
  await signInOnWww(wwwPage, accountA);
  await expectSessionReadNames(wwwPage, accountA);
  await wwwDocument(wwwPage);
  const appPage = await appOrigin(context);

  const reads = [
    { method: 'GET', path: '/api/auth/session' },
    { method: 'GET', path: '/api/internal/ws-auth' },
  ];
  const holds = await Promise.all(reads.map((read) => responseHolds.arm({ host: WWW_HOST, ...read })));
  const heldReads = [readSession(wwwPage), readViewer(wwwPage)];
  for (const held of holds) await held.untilHeld();

  const window = await edgeCookies.begin();
  expect(await postCredentialsLogin(appPage, accountB)).toBe(200);
  const loginB = loginWrite(await window.end(), CREDENTIALS_CALLBACK);

  const late = await edgeCookies.begin();
  for (const held of holds) await held.release();
  // The reads were A's when they were answered; they land and write no cookie.
  await Promise.allSettled(heldReads);
  const lateRecords = await late.end();
  expect(sessionSetCookies(lateRecords.filter((record) => reads.some((read) => read.path === record.path)))).toEqual(
    [],
  );
  const authSessionId = await expectBrowserReads(wwwPage, appPage, accountB);
  await expectSingleLogin(context, loginB, authSessionId);
  report(browserName, 'held-reads', { finalAccount: 'B', heldRepliesWroteCookies: false });
});

/**
 * Found by this spec (run 44425414071): WebKit keeps the host-only copy on www
 * when the login that clears it answers a fetch from the app host (a
 * same-site, cross-origin request); it stores the Domain cookie the same reply
 * writes. Chromium deletes the copy. The browser then still holds two
 * differing copies, so it reads as signed out on both hosts, never as another
 * account, until a login on www, which clears the copy in both engines.
 * Production www never writes a host-only login cookie (the canonical-origin
 * boot check refuses a deployment that would), so only a misconfigured
 * deployment could leave one. Whether to accept this is an owner question
 * (reported on #7596 B7c); the case stays strict everywhere else.
 */
const WEBKIT_KEEPS_HOST_ONLY_COPY_ON_APP_LOGIN = true;

for (const loginFrom of ['www', 'app'] as const) {
  test(`a host-only copy beside the Domain login cookie reads as signed out; the next login (from ${loginFrom}) clears it`, async ({
    context,
    freshAccount,
    edgeCookies,
    browserName,
  }) => {
    const accountA = freshAccount();
    const accountB = freshAccount();
    const wwwPage = await context.newPage();
    await signInOnWww(wwwPage, accountA);
    await expectSessionReadNames(wwwPage, accountA);
    await wwwDocument(wwwPage);
    const appPage = await appOrigin(context);
    // A copy under the same name without a Domain, as a preview, an older deployment or a sibling host could leave.
    await context.addCookies([
      {
        name: LOGIN_COOKIE,
        value: `stale-host-only-${randomUUID()}`,
        url: WWW_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const copies = await copiesOf(context, LOGIN_COOKIE);
    expect(copies.map((copy) => copy.hostOnly).sort()).toEqual([false, true]);
    // What the engine sends: both copies, in an order the design does not rely on.
    const sent = wwwPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/session');
    const conflicted = await readSession(wwwPage);
    const cookieHeader = (await (await sent).allHeaders()).cookie ?? '';
    const sentOrder = cookieHeader
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.startsWith(`${LOGIN_COOKIE}=`))
      .map((pair) => (pair.includes('stale-host-only-') ? 'host-only' : 'domain'));
    // Differing copies: signed out on www and from the app, never one of the two.
    expect(conflicted).toMatchObject({ status: 200, userId: null });
    expect(await onPage(appPage, readViewer)).toMatchObject({ authenticated: false });

    const window = await edgeCookies.begin();
    expect(await postCredentialsLogin(loginFrom === 'www' ? wwwPage : appPage, accountB)).toBe(200);
    const records = await window.end();
    const hostOnlyClear = sessionSetCookies(records).find(
      (cookie) =>
        cookie.name === LOGIN_COOKIE &&
        cookie.clears &&
        !cookie.attributes.some((attribute) => attribute.startsWith('Domain=')),
    );
    const copiesAfter = await copiesOf(context, LOGIN_COOKIE);
    report(browserName, `host-only-copy-login-from-${loginFrom}`, {
      sentOrder: sentOrder.length > 0 ? sentOrder : 'not visible to the test',
      readAs: 'signed out',
      loginCopiesAfterLogin: copiesAfter.map((copy) => (copy.hostOnly ? 'host-only' : 'domain')),
    });
    // Whatever the engine kept, the browser is never A again: B, or signed out.
    expect([accountB.userId, null]).toContain((await onPage(wwwPage, readSession)).userId);
    test.fail(
      browserName === 'webkit' && loginFrom === 'app' && WEBKIT_KEEPS_HOST_ONLY_COPY_ON_APP_LOGIN,
      'WebKit keeps the host-only copy after a login answered to the app host (WEBKIT_KEEPS_HOST_ONLY_COPY_ON_APP_LOGIN).',
    );
    expect(hostOnlyClear, 'the login clears the host-only copy').toBeTruthy();
    const authSessionId = await expectBrowserReads(wwwPage, appPage, accountB);
    await expectSingleLogin(context, loginWrite(records, CREDENTIALS_CALLBACK), authSessionId);
  });
}

test('a login outranks a bridged cookie whose bridging reply landed after it', async ({
  context,
  freshAccount,
  legacySession,
  responseHolds,
  edgeCookies,
  browserName,
}) => {
  const accountA = freshAccount();
  const accountB = freshAccount();
  // A browser signed in as A before the switch: the legacy cookie only.
  await legacySession.addTo(context, accountA, 'normal');
  const wwwPage = await wwwDocument(await context.newPage());
  const appPage = await appOrigin(context);

  const held = await responseHolds.arm({ host: WWW_HOST, method: 'GET', path: '/api/auth/session' });
  const bridging = readSession(wwwPage);
  await held.untilHeld();

  const window = await edgeCookies.begin();
  expect(await postCredentialsLogin(appPage, accountB)).toBe(200);
  const loginB = loginWrite(await window.end(), CREDENTIALS_CALLBACK);

  const late = await edgeCookies.begin();
  await held.release();
  await bridging;
  const bridgedWrites = sessionSetCookies(await late.end()).filter(
    (cookie) => cookie.name === BRIDGED_COOKIE && !cookie.clears,
  );
  // The bridging reply did land after the login and wrote A's bridged cookie.
  expect(bridgedWrites.length).toBeGreaterThan(0);
  expect((await copiesOf(context, BRIDGED_COOKIE)).length).toBe(1);

  // The login cookie outranks it: B on both hosts, and no later read writes anything.
  const after = await edgeCookies.begin();
  await expectBrowserReads(wwwPage, appPage, accountB);
  expect(sessionSetCookies(await after.end())).toEqual([]);
  expect(await copiesOf(context, LOGIN_COOKIE)).toEqual([{ hostOnly: false, digest: loginB }]);
  report(browserName, 'bridged-after-login', { finalAccount: 'B', bridgedCookieHeld: 'A', loginOutranks: true });
});

/** A new Apple identity at the stand-in (a new account on its first sign-in). */
function appleIdentity() {
  const id = randomUUID();
  return { subject: `apple-${id}`, email: `apple-${id}@privaterelay.example.test` };
}

/** Holds the resumed Apple callback (the GET that publishes the sign-in) and starts the sign-in in `page`. */
async function heldAppleSignIn(
  page: Page,
  responseHolds: ResponseHoldsFixture,
  identity: { subject: string; email: string },
) {
  const held = await responseHolds.arm({ host: WWW_HOST, method: 'GET', path: '/api/auth/callback/apple' });
  await continueWithApple(page, identity);
  await held.untilHeld();
  return held;
}

test("Apple: a held Apple sign-in landing after another account's login wins (accepted last-login-wins)", async ({
  context,
  freshAccount,
  responseHolds,
  edgeCookies,
  browserName,
}) => {
  const accountB = freshAccount();
  const identity = appleIdentity();
  const applePage = await context.newPage();
  const appPage = await appOrigin(context);
  const held = await heldAppleSignIn(applePage, responseHolds, identity);

  expect(await postCredentialsLogin(appPage, accountB)).toBe(200);
  const reader = await wwwDocument(await context.newPage());
  expect(await onPage(reader, readSession)).toMatchObject({ status: 200, userId: accountB.userId });

  const late = await edgeCookies.begin();
  await held.release();
  await applePage.waitForURL(`${WWW_ORIGIN}/settings`);
  const appleLogin = loginWrite(await late.end(), '/api/auth/callback/apple');

  // The Apple login arrived last, so the browser is the Apple account, on both hosts, with one copy.
  const session = await onPage(reader, readSession);
  expect(session.status).toBe(200);
  expect(session.userId).not.toBe(accountB.userId);
  expect(session.userId).toBeTruthy();
  const appleAccount = { userId: session.userId ?? '' };
  const authSessionId = await expectBrowserReads(reader, appPage, appleAccount);
  await expectSingleLogin(context, appleLogin, authSessionId);
  report(browserName, 'apple-after-other-login', { finalAccount: 'Apple account', outcome: 'last-login-wins' });
});

test('Apple: a held Apple sign-in landing after a newer sign-in of the same account keeps that account', async ({
  context,
  responseHolds,
  edgeCookies,
  browserName,
  openContext,
}) => {
  const identity = appleIdentity();
  // The Apple account exists already (a first sign-in in another browser).
  const elsewhere = await (await openContext()).newPage();
  await continueWithApple(elsewhere, identity);
  await elsewhere.waitForURL(`${WWW_ORIGIN}/settings`);
  const owner = await onPage(elsewhere, readSession);
  expect(owner.userId).toBeTruthy();
  const appleAccount = { userId: owner.userId ?? '' };

  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  const held = await heldAppleSignIn(firstTab, responseHolds, identity);
  // The same climber signs in with Apple again in another tab: a newer login of the same account.
  const window = await edgeCookies.begin();
  await continueWithApple(secondTab, identity);
  await secondTab.waitForURL(`${WWW_ORIGIN}/settings`);
  const newer = loginWrite(await window.end(), '/api/auth/callback/apple');

  const late = await edgeCookies.begin();
  await held.release();
  await firstTab.waitForURL(`${WWW_ORIGIN}/settings`);
  const older = loginWrite(await late.end(), '/api/auth/callback/apple');
  expect(older).not.toBe(newer);

  // The held login arrived last: same account either way, one copy, its own marker.
  const appPage = await appOrigin(context);
  const reader = await wwwDocument(await context.newPage());
  const authSessionId = await expectBrowserReads(reader, appPage, appleAccount);
  await expectSingleLogin(context, older, authSessionId);
  report(browserName, 'apple-after-same-account-login', {
    finalAccount: 'same Apple account',
    outcome: 'last-login-wins',
  });
});
