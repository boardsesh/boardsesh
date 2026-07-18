import NextAuth from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/app/lib/auth/auth-options';
import {
  appendLegacyHostOnlySessionCookieClear,
  isSecureCookieContext,
  responseSetsSessionCookie,
  sessionCookieName,
} from '@/app/lib/auth/secure-cookies';

type NextAuthRouteContext = {
  params: Promise<{ nextauth: string[] }>;
};

type NextAuthHandler = (request: NextRequest, context: NextAuthRouteContext) => Promise<Response>;

type ExpectedSignOutIdentity = {
  userId: string;
  authSessionId: string;
};

const handler = NextAuth(authOptions) as NextAuthHandler;

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

export async function POST(request: NextRequest, context: NextAuthRouteContext): Promise<Response> {
  const pathname = request.nextUrl.pathname.endsWith('/')
    ? request.nextUrl.pathname.slice(0, -1)
    : request.nextUrl.pathname;
  if (!pathname.endsWith('/api/auth/signout')) {
    return clearLegacyCookieIfSessionWritten(await handler(request, context));
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
  return clearLegacyCookieIfSessionWritten(await handler(request, context));
}
