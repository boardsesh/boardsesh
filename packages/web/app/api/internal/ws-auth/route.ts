import { type NextRequest, NextResponse } from 'next/server';
import { decode, getToken, type JWT } from 'next-auth/jwt';
import { isSecureCookieContext, sessionCookieName } from '@/app/lib/auth/secure-cookies';

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

/**
 * API endpoint to get a WebSocket authentication token.
 * Returns the NextAuth JWT token that can be passed to the WebSocket backend.
 */
export async function GET(request: NextRequest) {
  try {
    const secureCookie = isSecureCookieContext();
    // Pass cookieName + secureCookie explicitly: next-auth's internal derivation
    // breaks if NEXTAUTH_URL is set to an http:// value (the `??` only falls back
    // when NEXTAUTH_URL is unset, not when it's wrong).
    const tokenOptions = {
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie,
      cookieName: sessionCookieName(),
    };

    // Read the raw cookie bytes once (`raw: true` does not decrypt), then run a
    // single decrypt/decode to validate it. This is the same work `raw: false`
    // does internally, so decoding here directly avoids the second cookie read
    // and keeps the JWE decrypted exactly once per handshake.
    const token = await getToken({ ...tokenOptions, raw: true });
    if (typeof token !== 'string' || !token.trim()) {
      // User is not authenticated - this is OK, just return null
      return NextResponse.json({ token: null, authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    const nextAuthSecret = process.env.NEXTAUTH_SECRET;
    if (!nextAuthSecret) {
      // Server misconfiguration: without the secret the cookie can't be
      // validated. Warn loudly and fail closed to an anonymous response.
      console.warn('[ws-auth] NEXTAUTH_SECRET is not configured; treating the request as anonymous.');
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
    console.error('[ws-auth] Error getting token:', error);
    return NextResponse.json(
      { token: null, authenticated: false, error: 'Failed to get token' },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
}
