import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import {
  continueWithApple,
  readSession,
  readViewer,
  signInOnWww,
  signInWithGoogle,
  type ProviderStandInIdentity,
} from './helpers';
import {
  APP_ORIGIN,
  LEGACY_COOKIE,
  LOGIN_COOKIE,
  MARKER_COOKIE,
  WWW_HOST,
  WWW_ORIGIN,
  type SetCookieRecord,
} from './stack';
import { expect, markerSetCookies, sessionSetCookies, test } from './fixtures';

/**
 * #7596 B5b in a real browser, Chromium and WebKit, under
 * AUTH_BROWSER_SESSION_MODE=better-auth: Google and Apple sign-in through
 * www's own "Continue with ..." buttons, at stand-ins on their own sites
 * (auth-proofs/google-oidc-fixture.ts, apple-oidc-fixture.ts) that www's
 * providers reach through the e2e-only seam (oidc-stand-in.server.ts).
 *
 * - Google answers with a redirect; its callback publishes the login cookie,
 *   its legacy twin and the viewer marker, and the session the browser held
 *   before is gone.
 * - Apple answers with a cross-site form_post: www holds it and writes no
 *   session cookie, 303s to a same-site GET, and that GET publishes the login.
 *
 * A signed-in browser can sign in only with an identity that already has an
 * account (decision D1: an unknown one is refused with no cookie change), so
 * each identity first signs in once in a browser of its own.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');

function newIdentity(provider: 'google' | 'apple'): ProviderStandInIdentity {
  const id = randomUUID();
  return { subject: `${provider}-${id}`, email: `${provider}-${id}@example.test` };
}

/** The writes and clears a window's responses made to `path` on www. */
function writesTo(records: readonly SetCookieRecord[], method: string, path: string) {
  const matching = records.filter(
    (record) => record.host === WWW_HOST && record.method === method && record.path === path,
  );
  return {
    statuses: matching.map((record) => record.status),
    session: sessionSetCookies(matching),
    marker: markerSetCookies(matching),
  };
}

/** The account a provider identity belongs to, made by its first sign-in in another browser. */
async function accountOf(openContext: () => Promise<BrowserContext>, signIn: (page: Page) => Promise<void>) {
  const page = await (await openContext()).newPage();
  await signIn(page);
  const { userId } = await readSession(page);
  expect(userId).toBeTruthy();
  return userId ?? '';
}

async function appReader(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'commit' });
  return page;
}

test('Google: Continue with Google signs a signed-in browser in as the Google account on www and the app', async ({
  context,
  openContext,
  freshAccount,
  edgeCookies,
}) => {
  const identity = newIdentity('google');
  const googleAccount = await accountOf(openContext, (page) => signInWithGoogle(page, identity));
  const previous = freshAccount();
  const page = await context.newPage();
  await signInOnWww(page, previous);
  const before = await readSession(page);
  expect(before.userId).toBe(previous.userId);

  const { records } = await edgeCookies.during(() => signInWithGoogle(page, identity, { signedIn: true }));
  const callback = writesTo(records, 'GET', '/api/auth/callback/google');
  expect(callback.session.filter((cookie) => !cookie.clears).map((cookie) => cookie.name)).toEqual(
    expect.arrayContaining([LOGIN_COOKIE, LEGACY_COOKIE]),
  );
  expect(callback.marker.filter((cookie) => !cookie.clears).map((cookie) => cookie.name)).toEqual([MARKER_COOKIE]);

  const after = await readSession(page);
  expect(after).toMatchObject({ status: 200, userId: googleAccount });
  expect(after.authSessionId).not.toBe(before.authSessionId);
  expect(await readViewer(await appReader(context))).toMatchObject({ authenticated: true, userId: googleAccount });
  expect((await context.cookies(WWW_ORIGIN)).filter((cookie) => cookie.name === LOGIN_COOKIE)).toHaveLength(1);
});

test('Apple: the cross-site form_post is held with no session cookie, and the same-site GET publishes the login', async ({
  context,
  openContext,
  freshAccount,
  edgeCookies,
}) => {
  const identity = newIdentity('apple');
  const appleAccount = await accountOf(openContext, async (page) => {
    await continueWithApple(page, identity);
    await page.waitForURL(`${WWW_ORIGIN}/settings`);
  });
  const previous = freshAccount();
  const page = await context.newPage();
  await signInOnWww(page, previous);
  const before = await readSession(page);

  const { records } = await edgeCookies.during(async () => {
    await continueWithApple(page, identity, { signedIn: true });
    await page.waitForURL(`${WWW_ORIGIN}/settings`);
  });
  const held = writesTo(records, 'POST', '/api/auth/callback/apple');
  expect(held.statuses).toEqual([303]);
  expect(held.session).toEqual([]);
  expect(held.marker).toEqual([]);
  const published = writesTo(records, 'GET', '/api/auth/callback/apple');
  expect(published.session.filter((cookie) => !cookie.clears).map((cookie) => cookie.name)).toEqual(
    expect.arrayContaining([LOGIN_COOKIE, LEGACY_COOKIE]),
  );
  expect(published.marker.filter((cookie) => !cookie.clears).map((cookie) => cookie.name)).toEqual([MARKER_COOKIE]);

  const after = await readSession(page);
  expect(after).toMatchObject({ status: 200, userId: appleAccount });
  expect(after.authSessionId).not.toBe(before.authSessionId);
  expect(await readViewer(await appReader(context))).toMatchObject({ authenticated: true, userId: appleAccount });
  expect((await context.cookies(WWW_ORIGIN)).filter((cookie) => cookie.name === LOGIN_COOKIE)).toHaveLength(1);
});
