import { type NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
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

    // Validate the cookie through NextAuth's normal decrypt/decode path before
    // exposing its encrypted representation to the browser. `raw: true` alone
    // only reads the cookie bytes and can return malformed or subject-less data.
    const decodedToken = await getToken({ ...tokenOptions, raw: false });
    if (!decodedToken || typeof decodedToken.sub !== 'string' || !decodedToken.sub.trim()) {
      return NextResponse.json({ token: null, authenticated: false }, { headers: PRIVATE_NO_STORE_HEADERS });
    }

    const token = await getToken({ ...tokenOptions, raw: true });

    if (typeof token !== 'string' || !token.trim()) {
      // User is not authenticated - this is OK, just return null
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
