import { requiresWebSignOutForwarding } from '@boardsesh/auth-protocol';
import { forwardWebSignOut, responseClearsNextAuthSession } from '@/app/lib/auth/web-signout-command.server';
import { capturePresentedWebCredential } from '@/app/lib/auth/admitted-session.server';
import { withAuthResponseAdmission, type SignOutCompletion } from '@/app/lib/auth/auth-response-admission.server';
import NextAuth from 'next-auth';
import type { NextAuthOptions } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/app/lib/auth/auth-options';
import { withWebOAuthIdentity } from '@/app/lib/auth/web-oauth-request.server';
import {
  captureProviderOAuthRequest,
  createProviderOAuthOuter,
  type ProviderOAuthOuter,
} from '@/app/lib/auth/provider-oauth-outer.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { normalizeProviderSecurityAppleCallback } from '@/app/lib/auth/provider-security-apple-transport.server';
import {
  readSignInStartCallbackUrl,
  withPartnerSignInFailureReturn,
} from '@/app/lib/partner-oauth/sign-in-failure-return';
import {
  admitPasswordLogin,
  createPasswordCommandAuthRequest,
  unavailablePasswordAuthResponse,
} from '@/app/lib/auth/password-command-auth.server';
import {
  appendLegacyHostOnlySessionCookieClear,
  appendSignOutSessionCookieClears,
  isSecureCookieContext,
  responseSetsSessionCookie,
  sessionCookieNameCandidates,
} from '@/app/lib/auth/secure-cookies';
import {
  bindExpoReturnToState,
  readExpoReturnForState,
  redirectExpoOAuthResponse,
  validatedExpoReturnUrl,
  type ExpoWebOAuthProvider,
} from '@/app/lib/auth/expo-web-oauth-return';

type NextAuthRouteContext = {
  params: Promise<{ nextauth: string[] }>;
};

type NextAuthHandler = (request: NextRequest, context: NextAuthRouteContext) => Promise<Response>;

type ExpectedSignOutIdentity = {
  userId: string;
  authSessionId: string;
};

const handler = NextAuth(authOptions) as NextAuthHandler;
function handlerFor(options: NextAuthOptions): NextAuthHandler {
  return options === authOptions ? handler : (NextAuth(options) as NextAuthHandler);
}
const OAUTH_SIGNIN_PATH_PATTERN = /\/api\/auth\/signin\/(apple|google)\/?$/;
const OAUTH_CALLBACK_PATH_PATTERN = /\/api\/auth\/callback\/(apple|google)\/?$/;

function oauthProviderForPath(pathname: string, action: 'signin' | 'callback'): ExpoWebOAuthProvider | null {
  const pattern = action === 'signin' ? OAUTH_SIGNIN_PATH_PATTERN : OAUTH_CALLBACK_PATH_PATTERN;
  const match = pathname.match(pattern);
  return match?.[1] === 'apple' || match?.[1] === 'google' ? match[1] : null;
}

async function readOAuthForm(request: NextRequest): Promise<FormData | null> {
  try {
    return await request.clone().formData();
  } catch {
    return null;
  }
}

function stateFromAuthorizationRedirect(response: Response): string | null {
  const location = response.headers.get('Location');
  if (!location) return null;
  try {
    return new URL(location, 'https://provider.invalid').searchParams.get('state');
  } catch {
    return null;
  }
}

function responseContainsOAuthError(response: Response): boolean {
  const location = response.headers.get('Location');
  if (!location) return false;
  try {
    return new URL(location, 'https://auth.invalid').searchParams.has('error');
  } catch {
    return false;
  }
}

async function handleExpoOAuthPost(
  request: NextRequest,
  context: NextAuthRouteContext,
  pathname: string,
  handler: NextAuthHandler,
): Promise<Response | null> {
  const signInProvider = oauthProviderForPath(pathname, 'signin');
  if (signInProvider) {
    const form = await readOAuthForm(request);
    const returnUrl = validatedExpoReturnUrl(form?.get('callbackUrl') ?? null, signInProvider, request.nextUrl.origin);
    if (!returnUrl) return null;

    const response = clearLegacyCookieIfSessionWritten(await handler(request, context));
    const state = stateFromAuthorizationRedirect(response);
    if (state) return bindExpoReturnToState(response, request, state, signInProvider, returnUrl);
    return responseContainsOAuthError(response)
      ? redirectExpoOAuthResponse(response, request, null, returnUrl)
      : response;
  }

  const callbackProvider = oauthProviderForPath(pathname, 'callback');
  if (!callbackProvider) return null;
  const form = await readOAuthForm(request);
  const state = form?.get('state');
  if (typeof state !== 'string' || !state) return null;
  const descriptor = readExpoReturnForState(request, state, callbackProvider);
  if (!descriptor) return null;
  const response = clearLegacyCookieIfSessionWritten(await handler(request, context));
  return redirectExpoOAuthResponse(response, request, state, descriptor.returnUrl);
}

async function readExpectedSignOutIdentity(
  request: NextRequest,
): Promise<ExpectedSignOutIdentity | null | 'invalid' | 'unavailable'> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // Couldn't even read the body as form data (too large, wrong content-type,
    // a transient stream error). That's a server-side condition, not a client
    // identity mismatch — surface it as retryable ('unavailable' → 503) so the
    // caller doesn't treat a transient failure as a permanent identity change.
    return 'unavailable';
  }

  const expectedUserId = form.get('expectedUserId');
  const expectedAuthSessionId = form.get('expectedAuthSessionId');
  if (expectedUserId === null && expectedAuthSessionId === null) return null;
  if (
    typeof expectedUserId !== 'string' ||
    !expectedUserId.trim() ||
    typeof expectedAuthSessionId !== 'string' ||
    !expectedAuthSessionId.trim()
  ) {
    return 'invalid';
  }
  return { userId: expectedUserId.trim(), authSessionId: expectedAuthSessionId.trim() };
}

function guardedSignOutResponse(status: number, error: string): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}

// Delete the pre-migration host-only session cookie whenever NextAuth writes a
// fresh session cookie (login/refresh) so the legacy cookie can't shadow the new
// `Domain=.boardsesh.com` cookie or survive a later sign-out. Only on a write —
// never on a bare read, which would delete a not-yet-migrated user's only cookie.
function clearLegacyCookieIfSessionWritten(response: Response): Response {
  if (responseSetsSessionCookie(response)) {
    appendLegacyHostOnlySessionCookieClear(response);
  }
  return response;
}

async function postAuth(
  request: NextRequest,
  context: NextAuthRouteContext,
  options: NextAuthOptions,
  completeSignOut: SignOutCompletion,
): Promise<Response> {
  const handler = handlerFor(options);
  // Match the public NextAuth App Router dispatch exactly. URL suffixes can
  // differ from decoded catch-all parameters (and may contain extra segments).
  const [action, provider] = (await context.params).nextauth;
  const pathname = request.nextUrl.pathname.endsWith('/')
    ? request.nextUrl.pathname.slice(0, -1)
    : request.nextUrl.pathname;
  if (action === 'callback' && provider === 'credentials') {
    const admission = admitPasswordLogin(request);
    if (admission.limitedResponse) return admission.limitedResponse;
    const commandRequest = createPasswordCommandAuthRequest(options, undefined, admission.passwordAccepted);
    const commandHandler = NextAuth(commandRequest.options) as NextAuthHandler;
    const response = await commandHandler(request, context);
    return commandRequest.unavailable()
      ? unavailablePasswordAuthResponse(request.url)
      : clearLegacyCookieIfSessionWritten(response);
  }
  if (action !== 'signout') {
    const expoOAuthResponse = await handleExpoOAuthPost(request, context, pathname, handler);
    if (expoOAuthResponse) return expoOAuthResponse;
    return clearLegacyCookieIfSessionWritten(await handler(request, context));
  }

  const expectedIdentity = await readExpectedSignOutIdentity(request);
  // A standard NextAuth signOut() has no way to bind the request to the
  // session shown in its initiating tab. Requiring identity fields prevents an
  // old tab from deleting a cookie written by a newer login.
  if (expectedIdentity === 'unavailable') return guardedSignOutResponse(503, 'signout_identity_unreadable');
  if (expectedIdentity === null) return guardedSignOutResponse(400, 'signout_identity_required');
  if (expectedIdentity === 'invalid') return guardedSignOutResponse(400, 'invalid_signout_identity');

  // Both cookie names, preferred first — the same read the WebSocket handshake
  // does. If the identity guard only looked at the name isSecureCookieContext()
  // currently picks, a session living under the other name would fail the
  // comparison and turn every sign-out into a 409 the user cannot get past.
  const [preferredCookieName, fallbackCookieName] = sessionCookieNameCandidates();
  // getToken also accepts Authorization bearer credentials. Sign-out is bound
  // to the browser cookie: a bearer must not disguise which name was selected.
  const cookieRequest = new NextRequest(request.url, {
    headers: { cookie: request.headers.get('cookie') ?? '' },
  });
  const tokenOptions = {
    req: cookieRequest,
    secret: process.env.NEXTAUTH_SECRET,
    secureCookie: isSecureCookieContext(),
  };
  let token: Awaited<ReturnType<typeof getToken>>;
  let selectedCookieName = preferredCookieName;
  try {
    token = await getToken({ ...tokenOptions, cookieName: preferredCookieName });
    if (!token) {
      token = await getToken({ ...tokenOptions, cookieName: fallbackCookieName });
      selectedCookieName = fallbackCookieName;
    }
  } catch {
    return guardedSignOutResponse(503, 'signout_identity_unavailable');
  }

  if (token?.sub !== expectedIdentity.userId || token.authSessionId !== expectedIdentity.authSessionId) {
    return guardedSignOutResponse(409, 'signout_identity_changed');
  }
  // NextAuth's sign-out clears only the Domain-scoped cookie under the one name
  // it picked. Clear both names in both scopes, so the read fallback above can't
  // resurrect a session the user just signed out of.
  // The public handler must consume the same selected cookie as the identity
  // guard. Otherwise a fallback-only session produces a redirect with no clear,
  // which cannot prove a successful sign-out or trigger the backend denial.
  const signOutHandler = handlerFor({
    ...options,
    cookies: {
      ...options.cookies,
      sessionToken: {
        name: selectedCookieName,
        options: options.cookies?.sessionToken?.options ?? {},
      },
    },
  });
  const response = await signOutHandler(request, context);
  // Only a successful public NextAuth CSRF flow emits its session clear. Buffer
  // those headers until the independent backend SID denial is acknowledged.
  const clearedSession = responseClearsNextAuthSession(response);
  // A CSRF refusal must not be transformed into cookie clearing or a denial,
  // including when the legacy sign-out writer is selected.
  if (!clearedSession) return response;
  try {
    if (requiresWebSignOutForwarding(process.env)) {
      const presented = await capturePresentedWebCredential(request);
      if (!presented) return guardedSignOutResponse(503, 'signout_identity_unavailable');
      await forwardWebSignOut(presented.credential);
      completeSignOut(response, presented.credential);
    }
  } catch {
    return guardedSignOutResponse(503, 'signout_authority_unavailable');
  }
  appendSignOutSessionCookieClears(
    response,
    request.cookies.getAll().map((requestCookie) => requestCookie.name),
  );
  return response;
}

async function getAuth(
  request: NextRequest,
  context: NextAuthRouteContext,
  options: NextAuthOptions,
): Promise<Response> {
  const handler = handlerFor(options);
  const callbackProvider = oauthProviderForPath(request.nextUrl.pathname, 'callback');
  const state = request.nextUrl.searchParams.get('state');
  if (callbackProvider && state) {
    const descriptor = readExpoReturnForState(request, state, callbackProvider);
    if (descriptor) {
      const response = clearLegacyCookieIfSessionWritten(await handler(request, context));
      return redirectExpoOAuthResponse(response, request, state, descriptor.returnUrl);
    }
  }
  return clearLegacyCookieIfSessionWritten(await handler(request, context));
}

async function routeAuth(
  request: NextRequest,
  context: NextAuthRouteContext,
  provider: ProviderOAuthOuter | null,
): Promise<Response> {
  // Check both route authorities before a delegate can exchange a code or write a cookie.
  // The stored Facebook identity and an existing session remain readable.
  const { nextauth } = await context.params;
  let pathname = request.nextUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // An undecodable URL cannot name a configured provider.
  }
  if (
    ((nextauth[0] === 'signin' || nextauth[0] === 'callback') && nextauth[1] === 'facebook') ||
    /\/api\/auth\/(?:signin|callback)\/facebook(?:\/|$)/.test(pathname)
  ) {
    return NextResponse.json(
      { error: 'unsupported_provider' },
      { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  return withAuthResponseAdmission(
    request,
    context,
    async (completeSignOut) => {
      const response = await withWebOAuthIdentity(
        request,
        context,
        provider?.options ?? authOptions,
        (current, options) =>
          current.method === 'POST'
            ? postAuth(current, context, options, completeSignOut)
            : getAuth(current, context, options),
        provider?.delegate,
      );
      // Apple continuation clearing can clone the framework response. Quarantine
      // the finished flow response before acknowledging its exact admission.
      return provider ? provider.quarantine(response) : response;
    },
    provider?.completeAdmission,
    provider?.anonymousAdmission,
  );
}

async function composedAuth(
  request: NextRequest,
  context: NextAuthRouteContext,
  startCallbackUrl?: string | null,
): Promise<Response> {
  let captured: NextRequest;
  try {
    captured = captureProviderOAuthRequest(request);
  } catch {
    return unavailableCredentialResponse();
  }
  const normalized = await normalizeProviderSecurityAppleCallback(captured, context, authOptions);
  if (normalized) return normalized;
  const provider = await createProviderOAuthOuter(captured, context, authOptions);
  const invoke = async () =>
    withPartnerSignInFailureReturn(captured, await routeAuth(captured, context, provider), startCallbackUrl);
  // Every actual framework hook, admission, scoped-cookie clear and partner/
  // Expo decorator settles before the publisher builds its final SQL command.
  return provider ? provider.run(invoke) : invoke();
}

// A failed social sign-in that started on the partner sign-in page goes back
// there, not to /auth/login, which the iPhone app claims.
export async function GET(request: NextRequest, context: NextAuthRouteContext): Promise<Response> {
  const captured = new NextRequest(request.clone(), { headers: new Headers(request.headers) });
  return composedAuth(captured, context);
}

export async function POST(request: NextRequest, context: NextAuthRouteContext): Promise<Response> {
  const captured = new NextRequest(request.clone(), { headers: new Headers(request.headers) });
  // A sign-in start's own callbackUrl, read before NextAuth consumes the body.
  const startCallbackUrl = await readSignInStartCallbackUrl(captured);
  return composedAuth(captured, context, startCallbackUrl);
}
