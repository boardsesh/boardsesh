import NextAuth from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/app/lib/auth/auth-options';
import {
  appendLegacyHostOnlyOAuthFlowCookieClears,
  appendLegacyHostOnlySessionCookieClear,
  isSecureCookieContext,
  responseSetsSessionCookie,
  sessionCookieName,
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
const OAUTH_SIGNIN_PATH_PATTERN = /\/api\/auth\/signin\/(apple|google)\/?$/;
const OAUTH_CALLBACK_PATH_PATTERN = /\/api\/auth\/callback\/(apple|google)\/?$/;
// Any provider's callback, not just the OIDC ones — `callback-url` is consumed
// by the credentials and email callbacks too.
const ANY_CALLBACK_PATH_PATTERN = /\/api\/auth\/callback\/[^/]+\/?$/;

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
): Promise<Response | null> {
  // The /signin/* branch below deliberately does NOT call
  // clearLegacyOAuthFlowCookiesOnCallback. Not because the clears would be
  // unsafe here — host-only and Domain-scoped are separate storage entries, so a
  // Domain-less deletion next to a Domain-scoped write of the same name is
  // well-defined — but because one placement is enough and the callback is the
  // one every provider's flow reaches, GET and form_post alike.
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
  const response = clearLegacyOAuthFlowCookiesOnCallback(
    clearLegacyCookieIfSessionWritten(await handler(request, context)),
    pathname,
  );
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

// Sweep the pre-#3775 host-only duplicates of the OAuth-flow cookies out of the
// jar. This is hygiene, not a sign-in fix — a duplicate loses the read
// deterministically; see appendLegacyHostOnlyOAuthFlowCookieClears for why.
//
// The callback response is the natural place for it: by the time we hold it,
// NextAuth has already read state/pkce/callback-url off the REQUEST and expired
// its own copies on this same response, so the flow is over and the deletion
// cannot interact with it. Unconditional on outcome — an errored callback ends
// the flow just as definitively as a successful one.
function clearLegacyOAuthFlowCookiesOnCallback(response: Response, pathname: string): Response {
  if (ANY_CALLBACK_PATH_PATTERN.test(pathname)) {
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
  }
  return response;
}

export async function POST(request: NextRequest, context: NextAuthRouteContext): Promise<Response> {
  const pathname = request.nextUrl.pathname.endsWith('/')
    ? request.nextUrl.pathname.slice(0, -1)
    : request.nextUrl.pathname;
  const expoOAuthResponse = await handleExpoOAuthPost(request, context, pathname);
  if (expoOAuthResponse) return expoOAuthResponse;
  if (!pathname.endsWith('/api/auth/signout')) {
    return clearLegacyOAuthFlowCookiesOnCallback(
      clearLegacyCookieIfSessionWritten(await handler(request, context)),
      pathname,
    );
  }

  const expectedIdentity = await readExpectedSignOutIdentity(request);
  // A standard NextAuth signOut() has no way to bind the request to the
  // session shown in its initiating tab. Requiring identity fields prevents an
  // old tab from deleting a cookie written by a newer login.
  if (expectedIdentity === 'unavailable') return guardedSignOutResponse(503, 'signout_identity_unreadable');
  if (expectedIdentity === null) return guardedSignOutResponse(400, 'signout_identity_required');
  if (expectedIdentity === 'invalid') return guardedSignOutResponse(400, 'invalid_signout_identity');

  let token: Awaited<ReturnType<typeof getToken>>;
  try {
    token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie: isSecureCookieContext(),
      cookieName: sessionCookieName(),
    });
  } catch {
    return guardedSignOutResponse(503, 'signout_identity_unavailable');
  }

  if (token?.sub !== expectedIdentity.userId || token.authSessionId !== expectedIdentity.authSessionId) {
    return guardedSignOutResponse(409, 'signout_identity_changed');
  }
  // NextAuth's sign-out clears only the Domain-scoped cookie; also clear the
  // legacy host-only cookie so a pre-migration session can't survive logout.
  const response = await handler(request, context);
  appendLegacyHostOnlySessionCookieClear(response);
  return response;
}

export async function GET(request: NextRequest, context: NextAuthRouteContext): Promise<Response> {
  const pathname = request.nextUrl.pathname;
  const callbackProvider = oauthProviderForPath(pathname, 'callback');
  const state = request.nextUrl.searchParams.get('state');
  if (callbackProvider && state) {
    const descriptor = readExpoReturnForState(request, state, callbackProvider);
    if (descriptor) {
      const response = clearLegacyOAuthFlowCookiesOnCallback(
        clearLegacyCookieIfSessionWritten(await handler(request, context)),
        pathname,
      );
      return redirectExpoOAuthResponse(response, request, state, descriptor.returnUrl);
    }
  }
  return clearLegacyOAuthFlowCookiesOnCallback(
    clearLegacyCookieIfSessionWritten(await handler(request, context)),
    pathname,
  );
}
