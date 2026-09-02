import { type NextRequest, NextResponse } from 'next/server';
import { decode, getToken, type JWT } from 'next-auth/jwt';
import { isSecureCookieContext, sessionCookieNameCandidates } from '@/app/lib/auth/secure-cookies';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { reportHandledError } from '@/app/lib/observability/report-error';

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

/**
 * API endpoint to get a WebSocket authentication token.
 * Returns the NextAuth JWT token that can be passed to the WebSocket backend.
 */
export async function GET(request: NextRequest) {
  const log = createRequestLogger(request);
  try {
    // Pass cookieName + secureCookie explicitly: next-auth's internal derivation
    // breaks if NEXTAUTH_URL is set to an http:// value (the `??` only falls back
    // when NEXTAUTH_URL is unset, not when it's wrong). `secureCookie` only
    // steers next-auth's DEFAULT cookie name, which the explicit `cookieName`
    // always overrides — it stays here to document the context, not to select.
    const tokenOptions = {
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie: isSecureCookieContext(),
      raw: true,
    } as const;

    // Read the raw cookie bytes (`raw: true` does not decrypt), then run a
    // single decrypt/decode to validate it. This is the same work `raw: false`
    // does internally, so decoding here directly avoids the second cookie read
    // and keeps the JWE decrypted exactly once per handshake.
    //
    // Try both cookie names, preferred first: this module never loads
    // auth-options, so it depends entirely on the instrumentation hook having
    // patched NEXTAUTH_URL. Accepting either name means a session written under
    // the other one still authenticates the WebSocket handshake even if that
    // patch, or isSecureCookieContext() itself, is wrong (issue #4651). The
    // fallback costs nothing on the hit path and no extra decrypt on the miss
    // path — next-auth returns before `decode` when the cookie is absent.
    const [preferredCookieName, fallbackCookieName] = sessionCookieNameCandidates();
    let token = await getToken({ ...tokenOptions, cookieName: preferredCookieName });
    if (typeof token !== 'string' || !token.trim()) {
      token = await getToken({ ...tokenOptions, cookieName: fallbackCookieName });
    }
    if (typeof token !== 'string' || !token.trim()) {
      // User is not authenticated - this is OK, just return null
      return NextResponse.json({ token: null, authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    const nextAuthSecret = process.env.NEXTAUTH_SECRET;
    if (!nextAuthSecret) {
      // Server misconfiguration: without the secret the cookie can't be
      // validated. Warn loudly and fail closed to an anonymous response.
      log.warn('NEXTAUTH_SECRET is not configured; treating the request as anonymous.');
      return NextResponse.json({ token: null, authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    let decodedToken: JWT | null;
    try {
      decodedToken = await decode({ token, secret: nextAuthSecret });
    } catch {
      // A malformed or expired cookie is not authenticated — mirror the null that
      // `getToken({ raw: false })` returns for the same input rather than 500ing.
      decodedToken = null;
    }
    if (!decodedToken || typeof decodedToken.sub !== 'string' || !decodedToken.sub.trim()) {
      return NextResponse.json({ token: null, authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    const authSessionId =
      typeof decodedToken.authSessionId === 'string' && decodedToken.authSessionId.trim()
        ? decodedToken.authSessionId
        : undefined;

    return NextResponse.json(
      {
        token,
        authenticated: true,
        userId: decodedToken.sub,
        ...(authSessionId ? { authSessionId } : {}),
      },
      { headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    reportHandledError(error, { logger: log, message: 'Failed to read the WebSocket auth token' });
    return NextResponse.json(
      { token: null, authenticated: false, error: 'Failed to get token' },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
}
