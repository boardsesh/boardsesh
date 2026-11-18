import { expect, type Page } from '@playwright/test';
import { APP_ORIGIN, WS_HOST, WWW_ORIGIN, type SeededAccount } from './stack';

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
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(`${WWW_ORIGIN}/settings`);
}

/** Opens the app and declines the one-time analytics question a fresh account may be asked. */
export async function openApp(page: Page): Promise<void> {
  const consentPrompt = page.getByRole('button', { name: 'No thanks', exact: true });
  await page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
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
    .poll(async () => readSession(page), { timeout: 20_000, message: 'www session read (GET /api/auth/session)' })
    .toMatchObject({ status: 200, userId: account.userId });
}
