import 'server-only';
import NextAuth from 'next-auth';
import type { NextAuthOptions } from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { authOptions } from './auth-options';
import { capturePresentedWebCredential } from './admitted-session.server';
import { withAuthResponseAdmission } from './auth-response-admission.server';
import type { BrowserSessionCookieConfiguration, BrowserSessionRouteMode } from './browser-session-mode.server';
import {
  loginSessionCookies,
  presentedForLogin,
  readRequestBrowserSession,
  signOutBrowserSessionCookieClears,
  withoutSessionSetCookies,
  type RequestBrowserSession,
} from './browser-session.server';
import { CREDENTIAL_AUTHORITY_HEADER, unavailableCredentialResponse } from './credential-admission-response.server';
import { guardedSignOutResponse, readExpectedSignOutIdentity } from './guarded-signout.server';
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
import { createWebSessionCommandClient } from './web-session-command-client.server';
import { responseClearsNextAuthSession } from './web-signout-command.server';

type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };
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
    authOptions,
    undefined,
    admission.passwordAccepted,
    cloudflareVouchedVisitorAddress(request),
    presented ? { presented } : {},
  );
  const response = await (NextAuth(commandRequest.options) as NextAuthHandler)(request, context);
  if (commandRequest.unavailable()) return unavailablePasswordAuthResponse(request.url);
  const issued = commandRequest.issuedWebSession();
  // A session issued without NextAuth writing its cookie, or the reverse, is a
  // broken login: answer it as unavailable rather than half-publish it.
  if (!responseSetsSessionCookie(response)) return issued ? unavailablePasswordAuthResponse(request.url) : response;
  if (!issued) return unavailablePasswordAuthResponse(request.url);
  appendLegacyHostOnlySessionCookieClear(response);
  // The name comes from how this request got the session (a login), never from a session read's `source`.
  for (const setCookie of loginSessionCookies(cookies, issued.token, requestCookieNames(request)))
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
    // NextAuth answers a refused CSRF token with its own sign-out page and `csrf=true`.
    const url = new URL(destination);
    return !(url.pathname.endsWith('/signout') && url.searchParams.get('csrf') === 'true');
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

  let outcome: 'signed_out' | 'identity_changed';
  try {
    outcome = await createWebSessionCommandClient().signOut(session.presented, expected);
  } catch {
    return guardedSignOutResponse(503, 'signout_authority_unavailable');
  }
  if (outcome === 'identity_changed') return guardedSignOutResponse(409, 'signout_identity_changed');
  const carriedNames = requestCookieNames(request);
  appendSignOutSessionCookieClears(response, carriedNames);
  for (const clear of signOutBrowserSessionCookieClears(cookies, carriedNames))
    response.headers.append('Set-Cookie', clear);
  return response;
}

/**
 * `/api/auth/session` (GET, and POST for `update()`) under `better-auth`. A
 * first-party cookie is answered by the backend's session read in today's JSON
 * shape. A legacy cookie alone is answered by the legacy path as today (B2
 * bridges it). No answer writes or clears a session cookie.
 */
async function readSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  legacyRoute: () => Promise<Response>,
): Promise<Response> {
  let session: RequestBrowserSession;
  try {
    session = await readRequestBrowserSession(request, cookies);
  } catch {
    return unavailableCredentialResponse();
  }
  if (session.kind === 'conflicted') return NextResponse.json({}, { headers: PRIVATE });
  if (session.kind !== 'canonical') return withoutSessionSetCookies(await legacyRoute());
  try {
    const read = await createWebSessionCommandClient().read(session.presented);
    if (read.status === 'signed-out')
      return NextResponse.json({}, { headers: { ...PRIVATE, [CREDENTIAL_AUTHORITY_HEADER]: 'denied' } });
    const active = read.session;
    if (active.user.id !== active.userId) return unavailableCredentialResponse();
    return NextResponse.json(
      {
        user: { name: active.user.name, email: active.user.email, image: active.user.image, id: active.userId },
        expires: active.expiresAt,
        authGeneration: active.generation,
        authSessionId: active.authSessionId,
      },
      { headers: PRIVATE },
    );
  } catch {
    return unavailableCredentialResponse();
  }
}

/**
 * The `/api/auth/*` route when `AUTH_BROWSER_SESSION_MODE` is not `legacy`.
 * Login, sign-out and the session read move to the first-party cookie; csrf
 * keeps the legacy path without any session `Set-Cookie`; everything else
 * (providers, Google and Apple, the native transfer) keeps the legacy path
 * until B4 and B5 move it.
 */
export async function routeBrowserSessionAuth(
  request: NextRequest,
  context: AuthRouteContext,
  mode: Exclude<BrowserSessionRouteMode, { kind: 'legacy' }>,
  legacyRoute: () => Promise<Response>,
): Promise<Response> {
  const [action, provider] = (await context.params).nextauth;
  const credentialsLogin = request.method === 'POST' && action === 'callback' && provider === 'credentials';
  if (mode.kind === 'unavailable')
    return credentialsLogin ? unavailablePasswordAuthResponse(request.url) : unavailableCredentialResponse();
  if (credentialsLogin) return withAuthResponseAdmission(request, context, () => login(request, context, mode.cookies));
  if (request.method === 'POST' && action === 'signout') return signOut(request, context, mode.cookies);
  if (action === 'session') return readSession(request, mode.cookies, legacyRoute);
  if (action === 'csrf') return withoutSessionSetCookies(await legacyRoute());
  return legacyRoute();
}
