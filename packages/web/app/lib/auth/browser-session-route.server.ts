import 'server-only';
import NextAuth from 'next-auth';
import type { NextAuthOptions } from 'next-auth';
import type { NextRequest } from 'next/server';
import { createDeviceTokenAuthRequest } from './device-token-request.server';
import { authOptions } from './auth-options';
import { capturePresentedWebCredential } from './admitted-session.server';
import { withAuthResponseAdmission } from './auth-response-admission.server';
import type { BrowserSessionCookieConfiguration, BrowserSessionRouteMode } from './browser-session-mode.server';
import { resolveBrowserSession, sessionReadAnswer } from './browser-session-bridge.server';
import {
  loginSessionCookies,
  responseSetsBrowserLoginCookie,
  presentedForLogin,
  readRequestBrowserSession,
  signOutBrowserSessionCookieClears,
  withoutSessionSetCookies,
  type RequestBrowserSession,
} from './browser-session.server';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import {
  admitPasswordLogin,
  createPasswordCommandAuthRequest,
  unavailablePasswordAuthResponse,
} from './password-command-auth.server';
import {
  appendLegacyHostOnlySessionCookieClear,
  appendSignOutSessionCookieClears,
  responseSetsSessionCookie,
  sessionCookieNameCandidates,
} from './secure-cookies';
import { cloudflareVouchedVisitorAddress } from './trusted-client-ip.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { createWebSessionCommandClient } from './web-session-command-client.server';
import { responseClearsNextAuthSession } from './web-signout-command.server';

type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };

/** What the route lends this module, so the legacy path and the guarded sign-out form stay in one place. */
export type LegacyAuthRoute = Readonly<{
  legacyRoute: () => Promise<Response>;
  readExpectedSignOutIdentity: (
    request: NextRequest,
  ) => Promise<{ userId: string; authSessionId: string } | null | 'invalid' | 'unavailable'>;
  guardedSignOutResponse: (status: number, error: string) => Response;
}>;
type NextAuthHandler = (request: NextRequest, context: AuthRouteContext) => Promise<Response>;

const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

function requestCookieNames(request: NextRequest): string[] {
  return request.cookies.getAll().map((requestCookie) => requestCookie.name);
}

/**
 * Login under `better-auth`: the staged password command also issues the
 * first-party session, revoking the one this request presented. NextAuth's
 * reply is kept as it is, so it still writes the legacy cookie for the 30-day
 * rollback window, now naming the same session through the credential proof.
 * The login cookie is appended after it. A wrong password or a login waiting
 * for email verification changes no session cookie.
 */
async function login(
  request: NextRequest,
  context: AuthRouteContext,
  cookies: BrowserSessionCookieConfiguration,
  options: NextAuthOptions,
): Promise<Response> {
  const admission = admitPasswordLogin(request);
  if (admission.limitedResponse) return admission.limitedResponse;
  let session: RequestBrowserSession;
  try {
    session = await readRequestBrowserSession(request, cookies);
  } catch {
    return unavailablePasswordAuthResponse(request.url);
  }
  const presented = presentedForLogin(session);
  const commandRequest = createPasswordCommandAuthRequest(
    options,
    undefined,
    admission.passwordAccepted,
    cloudflareVouchedVisitorAddress(request),
    { webSession: presented ? { presented } : {}, cookieHeader: request.headers.get('cookie') },
  );
  const response = await (NextAuth(commandRequest.options) as NextAuthHandler)(request, context);
  const retryAfterSeconds = commandRequest.limited();
  if (retryAfterSeconds !== undefined) return unavailablePasswordAuthResponse(request.url, retryAfterSeconds);
  if (commandRequest.unavailable()) return unavailablePasswordAuthResponse(request.url);
  const issued = commandRequest.issuedWebSession();
  // A session issued without NextAuth writing its cookie, or the reverse, is a
  // broken login: answer it as unavailable rather than half-publish it.
  if (!responseSetsSessionCookie(response)) return issued ? unavailablePasswordAuthResponse(request.url) : response;
  if (!issued) return unavailablePasswordAuthResponse(request.url);
  appendLegacyHostOnlySessionCookieClear(response);
  // The name comes from how this request got the session (a login), never from a session read's `source`.
  for (const setCookie of loginSessionCookies(cookies, issued.token, issued.sessionId, requestCookieNames(request)))
    response.headers.append('Set-Cookie', setCookie);
  return response;
}

/** NextAuth's own CSRF verdict on its sign-out reply. */
async function nextAuthAcceptedSignOut(response: Response, legacyCookiePresent: boolean): Promise<boolean> {
  // The same evidence today's guarded sign-out uses when a legacy cookie exists.
  if (legacyCookiePresent) return responseClearsNextAuthSession(response);
  if (response.status !== 200 && response.status !== 302) return false;
  let destination = response.headers.get('Location');
  if (!destination) {
    try {
      const body: unknown = await response.clone().json();
      if (body && typeof body === 'object' && 'url' in body && typeof body.url === 'string') destination = body.url;
    } catch {
      return false;
    }
  }
  if (!destination) return false;
  try {
    // NextAuth answers a refused CSRF token with exactly `${NEXTAUTH_URL}/api/auth/signout?csrf=true`
    // (next-auth/core/index.js, POST signout); anything else is the caller's own callbackUrl.
    const url = new URL(destination);
    const publicOrigin = resolvePublicAuthOrigin();
    const refusal =
      url.pathname === '/api/auth/signout' &&
      url.search === '?csrf=true' &&
      (publicOrigin === undefined || url.origin === publicOrigin);
    return !refusal;
  } catch {
    return false;
  }
}

/**
 * Guarded sign-out under `better-auth`: the same form fields and the same 400,
 * 409 and 503 answers as today. NextAuth still checks the CSRF token. The
 * backend ends the presented session (the first-party cookie's token when
 * there is one, else the legacy cookie) only if it is still the login the tab
 * expected; then every session cookie name is cleared. On 409 or 503 nothing is.
 */
async function signOut(
  request: NextRequest,
  context: AuthRouteContext,
  cookies: BrowserSessionCookieConfiguration,
  { readExpectedSignOutIdentity, guardedSignOutResponse }: LegacyAuthRoute,
): Promise<Response> {
  const expected = await readExpectedSignOutIdentity(request);
  if (expected === 'unavailable') return guardedSignOutResponse(503, 'signout_identity_unreadable');
  if (expected === null) return guardedSignOutResponse(400, 'signout_identity_required');
  if (expected === 'invalid') return guardedSignOutResponse(400, 'invalid_signout_identity');

  let session: RequestBrowserSession;
  let legacyCookie: Awaited<ReturnType<typeof capturePresentedWebCredential>>;
  try {
    session = await readRequestBrowserSession(request, cookies);
    legacyCookie = await capturePresentedWebCredential(request);
  } catch {
    return guardedSignOutResponse(503, 'signout_identity_unavailable');
  }
  // Signed out, or a conflicted login cookie: not the login the tab shows.
  if (session.kind === 'none' || session.kind === 'conflicted')
    return guardedSignOutResponse(409, 'signout_identity_changed');
  const carriedNames = requestCookieNames(request);
  const clearEverySessionCookie = (cleared: Response): Response => {
    appendSignOutSessionCookieClears(cleared, carriedNames);
    for (const clear of signOutBrowserSessionCookieClears(cookies, carriedNames))
      cleared.headers.append('Set-Cookie', clear);
    return cleared;
  };

  const options: NextAuthOptions = {
    ...authOptions,
    cookies: {
      ...authOptions.cookies,
      sessionToken: {
        name: legacyCookie?.cookieName ?? sessionCookieNameCandidates()[0],
        options: authOptions.cookies?.sessionToken?.options ?? {},
      },
    },
  };
  const response = await (NextAuth(options) as NextAuthHandler)(request, context);
  response.headers.set('Cache-Control', PRIVATE['Cache-Control']);
  // A CSRF refusal goes back as NextAuth wrote it, with no revocation and no clears.
  if (!(await nextAuthAcceptedSignOut(response, legacyCookie !== null))) return withoutSessionSetCookies(response);
  // A legacy cookie too long for any command reads as signed out everywhere, so
  // there is no session to end: clearing it is the whole sign-out.
  if (session.kind === 'oversized-legacy') return clearEverySessionCookie(response);

  let outcome: 'signed_out' | 'identity_changed';
  try {
    outcome = await createWebSessionCommandClient().signOut(session.presented, expected);
  } catch {
    return guardedSignOutResponse(503, 'signout_authority_unavailable');
  }
  if (outcome === 'identity_changed') return guardedSignOutResponse(409, 'signout_identity_changed');
  return clearEverySessionCookie(response);
}

/**
 * `/api/auth/session` (GET, and POST for `update()`) under `better-auth`. A
 * first-party cookie is answered by the backend's session read in today's JSON
 * shape. A GET with a legacy cookie and no first-party cookie of either name
 * (verified or not) bridges it (B2b); so does a GET whose active first-party
 * cookie is older than a legacy login beside it (a login made during a
 * rollback). POST never bridges and answers a legacy cookie from the legacy
 * path. Who the browser is comes from `resolveBrowserSession`, the one
 * resolver ws-auth uses too (B3b), so both answer the same ids. A session read
 * writes or clears a session cookie in three planned cases only
 * (`sessionReadAnswer`): the bridged cookie, the clears of a stale first-party
 * cookie a newer legacy login replaces, and the clears of a legacy cookie the
 * backend denies. Nothing else does.
 */
async function readSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  legacyRoute: () => Promise<Response>,
): Promise<Response> {
  const resolution = await resolveBrowserSession(request, cookies, {
    bridges: request.method === 'GET',
    bucket: 'session-read',
  });
  return sessionReadAnswer(request, cookies, resolution, legacyRoute);
}

/**
 * The `/api/auth/*` route when `AUTH_BROWSER_SESSION_MODE` is not `legacy`.
 * Login, sign-out and the session read move to the first-party cookie; csrf
 * keeps the legacy path without any session `Set-Cookie`; everything else
 * (providers, Google and Apple through their own session publication, the
 * refused native transfer) goes through the legacy path.
 */
export async function routeBrowserSessionAuth(
  request: NextRequest,
  context: AuthRouteContext,
  mode: Exclude<BrowserSessionRouteMode, { kind: 'legacy' }>,
  legacy: LegacyAuthRoute,
): Promise<Response> {
  const [action, provider] = (await context.params).nextauth;
  const credentialsLogin = request.method === 'POST' && action === 'callback' && provider === 'credentials';
  if (mode.kind === 'unavailable')
    return credentialsLogin ? unavailablePasswordAuthResponse(request.url) : unavailableCredentialResponse();
  if (credentialsLogin) {
    const recognition = createDeviceTokenAuthRequest(authOptions, (response) =>
      responseSetsBrowserLoginCookie(response, mode.cookies),
    );
    const response = await withAuthResponseAdmission(request, context, () =>
      login(request, context, mode.cookies, recognition.options),
    );
    return recognition.decorate(response);
  }
  if (request.method === 'POST' && action === 'signout') return signOut(request, context, mode.cookies, legacy);
  if (action === 'session') return readSession(request, mode.cookies, legacy.legacyRoute);
  if (action === 'csrf') return withoutSessionSetCookies(await legacy.legacyRoute());
  // Google and Apple publish their own first-party session with the legacy
  // twin (B5b, `web-oauth-session.server.ts`). The native transfer provider is
  // refused under this mode (B4c-web), so no other provider login remains.
  return legacy.legacyRoute();
}
