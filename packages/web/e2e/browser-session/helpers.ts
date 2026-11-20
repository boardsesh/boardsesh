import { expect, type Page } from '@playwright/test';
import {
  APP_ORIGIN,
  APPLE_STAND_IN_ORIGIN,
  GOOGLE_STAND_IN_ORIGIN,
  WS_HOST,
  WWW_ORIGIN,
  type SeededAccount,
} from './stack';

/** What www's cookie route (`/api/internal/ws-auth`) says about the viewer. */
export interface WsAuthRead {
  authenticated: boolean;
  userId?: string;
  authSessionId?: string;
}

/** The viewer www's cookie route answers for, called from the page's own origin or cross-origin from the app. */
export async function readViewer(page: Page): Promise<WsAuthRead> {
  return page.evaluate(async (wwwOrigin) => {
    const response = await fetch(`${wwwOrigin}/api/internal/ws-auth`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const { authenticated, userId, authSessionId } = (await response.json()) as WsAuthRead;
    return { authenticated, userId, authSessionId };
  }, WWW_ORIGIN);
}

/** Signs `account` in through www's own login form and lands on /settings. */
export async function signInOnWww(page: Page, account: SeededAccount): Promise<void> {
  await page.goto(`${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent('/settings')}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${WWW_ORIGIN}/settings`);
}

/** Opens the app and declines the one-time analytics question a fresh account may be asked. */
export async function openApp(page: Page): Promise<void> {
  const consentPrompt = page.getByRole('button', { name: 'No thanks', exact: true });
  await page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
  });
  // WebKit has left the app tab blank (nothing rendered for two minutes) in a few runs; its own
  // errors go to the run log so the next one says why.
  page.on('pageerror', (error) => console.info(`[app-tab] page error: ${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.info(`[app-tab] console error: ${message.text().slice(0, 300)}`);
  });
  await page.goto(`${APP_ORIGIN}/`);
}

/** ws-auth's whole answer, token included, as a browser tab on either origin gets it. */
export interface WsAuthAnswer extends WsAuthRead {
  status: number;
  token: string | null;
}

export async function fetchWsAuth(page: Page): Promise<WsAuthAnswer> {
  return page.evaluate(async (wwwOrigin) => {
    const response = await fetch(`${wwwOrigin}/api/internal/ws-auth`, { credentials: 'include', cache: 'no-store' });
    const body = (await response.json()) as {
      authenticated: boolean;
      userId?: string;
      authSessionId?: string;
      token?: string | null;
    };
    return {
      status: response.status,
      authenticated: body.authenticated,
      userId: body.userId,
      authSessionId: body.authSessionId,
      token: body.token ?? null,
    };
  }, WWW_ORIGIN);
}

/** www's session read (`GET /api/auth/session`): the user id and session id, or nulls when signed out. */
export async function readSession(
  page: Page,
): Promise<{ status: number; userId: string | null; authSessionId: string | null }> {
  return page.evaluate(async (wwwOrigin) => {
    const response = await fetch(`${wwwOrigin}/api/auth/session`, { credentials: 'include', cache: 'no-store' });
    const body = (await response.json().catch(() => ({}))) as { user?: { id?: string }; authSessionId?: string };
    return { status: response.status, userId: body.user?.id ?? null, authSessionId: body.authSessionId ?? null };
  }, WWW_ORIGIN);
}

/** A GraphQL request to the backend with `token` as the bearer, from the page's own origin. Returns the status. */
export async function graphqlStatusWithToken(page: Page, token: string): Promise<number> {
  return page.evaluate(
    async ({ url, bearer }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      return response.status;
    },
    { url: `https://${WS_HOST}/graphql`, bearer: token },
  );
}

/** Signs the tab's account out through www's own sign-out page. */
export async function signOutOnWww(page: Page): Promise<void> {
  await page.goto(`${WWW_ORIGIN}/auth/signout?callbackUrl=${encodeURIComponent('/')}`);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signout'));
}

/**
 * Marks the current document. `isSameDocument` is then false after any reload
 * or navigation to a new document, which is how a spec sees the app's
 * reload-from-root on an account change without racing it.
 */
export async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __browserSessionMark?: boolean }).__browserSessionMark = true;
  });
}

export async function isSameDocument(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(
      () => (window as unknown as { __browserSessionMark?: boolean }).__browserSessionMark === true,
    );
  } catch {
    // The context was torn down mid-navigation: a new document is on its way.
    return false;
  }
}

/**
 * www's session read names `account` within 20 s. Called right after a sign-in
 * or a bridge, so a spec whose later steps wait minutes for the app fails here,
 * fast and with the cause, when the session read itself is broken.
 */
export async function expectSessionReadNames(page: Page, account: SeededAccount): Promise<void> {
  await expect
    .poll(
      // The tab's own guard may reload it for the new account while a read is out (the
      // viewer marker, or focus); that read is lost with its document, so ask again.
      async () =>
        readSession(page).catch((error: unknown) => {
          if (error instanceof Error && /Execution context was destroyed|navigation/i.test(error.message))
            return { status: 0, userId: null, authSessionId: null };
          throw error;
        }),
      { timeout: 20_000, message: 'www session read (GET /api/auth/session)' },
    )
    .toMatchObject({ status: 200, userId: account.userId });
}

/**
 * The credentials POST the login form's `signIn()` sends to www, with the csrf
 * token and the browser's cookies, from whichever page `page` shows: a www tab,
 * or an app.boardsesh.com tab, whose sign-in calls www's auth routes
 * cross-origin with credentials (cross-subdomain-cors.ts). Returns the status.
 */
export async function postCredentialsLogin(page: Page, account: SeededAccount): Promise<number> {
  return page.evaluate(
    async ({ origin, email, password }) => {
      const include = { credentials: 'include' as const, cache: 'no-store' as const };
      const { csrfToken } = (await (await fetch(`${origin}/api/auth/csrf`, include)).json()) as { csrfToken: string };
      const response = await fetch(`${origin}/api/auth/callback/credentials`, {
        ...include,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrfToken, email, password, json: 'true', callbackUrl: '/settings' }),
      });
      return response.status;
    },
    { origin: WWW_ORIGIN, email: account.email, password: account.password },
  );
}

/**
 * Logs `account` in on www from a tab that may already be signed in as
 * someone else, then loads /settings. The login page sends a signed-in
 * browser on to its callback, so a second login in one browser comes from a
 * login form left open in another tab; this sends that form's request.
 */
export async function signInOverExistingSession(page: Page, account: SeededAccount): Promise<void> {
  if (!page.url().startsWith(WWW_ORIGIN)) await page.goto(`${WWW_ORIGIN}/help`);
  expect(await postCredentialsLogin(page, account)).toBe(200);
  // The tab's own guard may already be reloading it for the new account, which aborts a navigation
  // started at the same moment; that reload is the design, so go to /settings once it is done.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(`${WWW_ORIGIN}/settings`);
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
      await page.waitForLoadState('load');
    }
  }
}

/**
 * Focuses `page` until its document is replaced (the guard's reload after an
 * account change), within 90 s. Headless tabs get no real focus change, so it
 * dispatches `focus` and `visibilitychange`, the listeners a real focus runs;
 * both clients throttle their focus probe (www to one per 30 s), hence the
 * repeats. The page must have been marked with `markDocument` first.
 */
export async function focusUntilReloaded(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.bringToFront();
        await page
          .evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
          })
          .catch(() => undefined);
        return isSameDocument(page);
      },
      { timeout: 90_000, intervals: [2_000, 5_000, 10_000], message: 'the tab reloads after the account change' },
    )
    .toBe(false);
}

/** Who signs in at a provider stand-in (auth-proofs/apple-oidc-fixture.ts, google-oidc-fixture.ts). */
export interface ProviderStandInIdentity {
  subject: string;
  email: string;
}

/**
 * Opens the provider's stand-in sign-in page. A signed-out browser presses
 * www's own "Continue with ..." button on the login page; a signed-in one
 * (which the login page sends on to its callback) starts the same request the
 * button's `signIn()` sends, from a www page.
 */
async function openProviderSignIn(page: Page, provider: 'apple' | 'google', callbackPath: string, signedIn: boolean) {
  const standIn = provider === 'apple' ? APPLE_STAND_IN_ORIGIN : GOOGLE_STAND_IN_ORIGIN;
  if (!signedIn) {
    await page.goto(`${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent(callbackPath)}`);
    await page
      .getByRole('button', { name: provider === 'apple' ? 'Continue with Apple' : 'Continue with Google' })
      .click();
  } else {
    if (!page.url().startsWith(WWW_ORIGIN)) await page.goto(`${WWW_ORIGIN}/help`);
    const authorizationUrl = await page.evaluate(
      async ({ provider, callbackUrl }) => {
        const include = { credentials: 'include' as const, cache: 'no-store' as const };
        const { csrfToken } = (await (await fetch('/api/auth/csrf', include)).json()) as { csrfToken: string };
        const response = await fetch(`/api/auth/signin/${provider}`, {
          ...include,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrfToken, callbackUrl, json: 'true' }),
        });
        return ((await response.json()) as { url: string }).url;
      },
      { provider, callbackUrl: `${WWW_ORIGIN}${callbackPath}` },
    );
    await page.goto(authorizationUrl);
  }
  await page.waitForURL((url) => url.origin === standIn);
}

/**
 * Signs in as `identity` at the Apple stand-in, whose page then posts its form
 * to www cross-site. Returns once that form is on its way; the caller waits
 * for where it lands.
 */
export async function continueWithApple(
  page: Page,
  identity: ProviderStandInIdentity,
  { callbackPath = '/settings', signedIn = false } = {},
) {
  await openProviderSignIn(page, 'apple', callbackPath, signedIn);
  await page.getByLabel('Apple subject').fill(identity.subject);
  await page.getByLabel('Apple email').fill(identity.email);
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
}

/** Signs in as `identity` at the Google stand-in, which redirects back to www; lands on the callback path. */
export async function signInWithGoogle(
  page: Page,
  identity: ProviderStandInIdentity,
  { callbackPath = '/settings', signedIn = false } = {},
) {
  await openProviderSignIn(page, 'google', callbackPath, signedIn);
  await page.getByLabel('Google subject').fill(identity.subject);
  await page.getByLabel('Google email').fill(identity.email);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL(`${WWW_ORIGIN}${callbackPath}`);
}
