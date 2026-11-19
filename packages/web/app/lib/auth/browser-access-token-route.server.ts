import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { webLogger } from '@/app/lib/observability/logger';
import { resolveBrowserSession } from './browser-session-bridge.server';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { createWebSessionCommandClient, type WebSessionAccessResult } from './web-session-command-client.server';

const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

function signedOut(status: 200 | 401): NextResponse {
  return NextResponse.json({ token: null, authenticated: false }, { status, headers: PRIVATE });
}

/**
 * `/api/internal/ws-auth` under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B3b): the backend's 15-minute browser access token, never the session
 * cookie's own token or the 30-day NextAuth JWE.
 *
 * Who the browser is comes from `resolveBrowserSession`, the resolver the
 * session read uses, so `userId` and `authSessionId` always equal what
 * `/api/auth/session` answers for the same request. Unlike the session read,
 * ws-auth never writes or clears a cookie: a legacy-only browser is bridged
 * without one (the backend gives the same token for the same cookie, so the
 * next session read sets exactly that cookie), in its own rate-limit bucket.
 *
 * - 200 `{ token, authenticated: true, userId, authSessionId, expiresAt, expiresIn }`:
 *   `expiresAt` is the token's end (at most 15 minutes away) and `expiresIn`
 *   the seconds left until it, which is what clients time their refresh by.
 * - 200 `{ token: null, authenticated: false }`: no session cookie, a
 *   conflicted one, an oversized legacy cookie, a plain-named legacy cookie in
 *   a secure context, or a legacy login the backend denies.
 * - 401 `{ token: null, authenticated: false }`: the cookie's session ended (a
 *   dead first-party cookie, with no fall back to the legacy cookie). The
 *   client re-reads the session, which answers signed out.
 * - 503: the backend is unavailable or answered nothing that parses, or a
 *   bridge is over its limit or failing. The client keeps its session and
 *   retries with backoff.
 *
 * The token goes only into the response body, never into a log line.
 */
export async function browserAccessTokenAnswer(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
): Promise<Response> {
  try {
    const resolution = await resolveBrowserSession(request, cookies, { bridges: true, bucket: 'ws-auth' });
    if (resolution.kind === 'unavailable' || resolution.kind === 'legacy-answer')
      return unavailableCredentialResponse();
    if (resolution.kind === 'signed-out') return signedOut(resolution.reason === 'session-ended' ? 401 : 200);
    let access: WebSessionAccessResult;
    try {
      access = await createWebSessionCommandClient().access({ kind: 'canonical-token', token: resolution.token });
    } catch {
      return unavailableCredentialResponse();
    }
    if (access.status === 'no-session') return signedOut(401);
    if (access.status === 'bridge-required') return unavailableCredentialResponse();
    const { grant } = access;
    // The token must name the session the resolver found, or the page would
    // hold a token for another login than its session JSON shows.
    if (grant.userId !== resolution.session.userId || grant.authSessionId !== resolution.session.authSessionId)
      return unavailableCredentialResponse();
    return NextResponse.json(
      {
        token: grant.accessToken,
        authenticated: true,
        userId: grant.userId,
        authSessionId: grant.authSessionId,
        expiresAt: grant.accessTokenExpiresAt,
        // Seconds left, by this server's clock: a client times its refresh
        // from when it received the token, never from its own clock against
        // `expiresAt`, which may be minutes off.
        expiresIn: Math.max(0, Math.floor((Date.parse(grant.accessTokenExpiresAt) - Date.now()) / 1000)),
      },
      { headers: PRIVATE },
    );
  } catch (error) {
    // The error's name only: a message could carry a credential.
    webLogger.error('browser access token failed', { error: error instanceof Error ? error.name : 'unknown' });
    return unavailableCredentialResponse();
  }
}
