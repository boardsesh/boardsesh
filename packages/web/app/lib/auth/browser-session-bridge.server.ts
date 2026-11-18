import 'server-only';
import { decode } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import type { PresentedWebSession } from '@boardsesh/auth-protocol';
import type { BrowserSessionCookieKind } from '@boardsesh/auth-protocol/browser-session-cookie';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { bridgedSessionCookies, readRequestLegacyCookie, withoutSessionSetCookies } from './browser-session.server';
import { CREDENTIAL_AUTHORITY_HEADER } from './credential-admission-response.server';
import { checkRateLimit } from './rate-limiter';
import { appendSignOutSessionCookieClears, sessionCookieName } from './secure-cookies';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';
import { createWebSessionCommandClient, type ActiveWebSession } from './web-session-command-client.server';

type LegacyPresented = Extract<PresentedWebSession, { kind: 'legacy-jwe' }>;

/** The private, uncached headers of every session answer. `no-store` on anything that sets the cookie. */
const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

/** Bridges per client address and minute. A browser bridges once; a reload loop or a scripted caller stops here. */
export const BRIDGES_PER_CLIENT = 20;
const BRIDGE_WINDOW_MS = 60_000;

/** Today's session JSON shape, as the session read answers it. */
export function sessionJson(active: ActiveWebSession): Record<string, unknown> {
  return {
    user: { name: active.user.name, email: active.user.email, image: active.user.image, id: active.userId },
    expires: active.expiresAt,
    authGeneration: active.generation,
    authSessionId: active.authSessionId,
  };
}

/**
 * The legacy cookie of this request when it is a newer login than the active
 * first-party session (coordinator decision (c), B2b, and review H1): a login
 * made while the mode was `legacy` (a rollback) wrote only the legacy cookie
 * and left the stale first-party cookie in place.
 *
 * - Beside a login cookie: a different session id and a sign-in time
 *   (`auth_time`, else the cookie's issue time) later than the session's
 *   `authenticatedAt`. Every response that writes a login cookie also writes its
 *   legacy twin with the same id (or a legacy-only login clears the first-party
 *   names), so a legacy cookie with another id was written later; the time only
 *   confirms it.
 * - Beside a bridged cookie: a string `authSessionId` that differs from the
 *   bridged session's. No time test: a bridged row's `authenticatedAt` is
 *   usually unknown, and the row's id is the claim of the cookie it was bridged
 *   from. A cookie without the claim cannot be a newer login (every sign-in
 *   sets one).
 *
 * Only the legacy name this deployment writes counts. The same session id, an
 * older cookie, an unknown `authenticatedAt` beside a login cookie, or a cookie
 * that does not decode: undefined, and the first-party cookie wins as usual.
 */
export async function newerLegacyLogin(
  request: NextRequest,
  active: ActiveWebSession,
  cookieKind: BrowserSessionCookieKind,
): Promise<LegacyPresented | undefined> {
  if (cookieKind === 'login' && active.authenticatedAt === null) return undefined;
  const legacy = await readRequestLegacyCookie(request);
  if (legacy.kind !== 'legacy' || legacy.cookieName !== sessionCookieName()) return undefined;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return undefined;
  let claims: Awaited<ReturnType<typeof decode>>;
  try {
    claims = await decode({ token: legacy.presented.credential, secret });
  } catch {
    return undefined;
  }
  if (!claims) return undefined;
  const legacySessionId = typeof claims.authSessionId === 'string' ? claims.authSessionId : undefined;
  if (legacySessionId === active.authSessionId) return undefined;
  if (cookieKind === 'bridged') return legacySessionId === undefined ? undefined : legacy.presented;
  const signedInAt = typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat;
  if (typeof signedInAt !== 'number' || active.authenticatedAt === null) return undefined;
  return signedInAt * 1000 > Date.parse(active.authenticatedAt) ? legacy.presented : undefined;
}

export type BridgeFallback = () => Promise<Response>;

/**
 * Bridges the request's legacy cookie on a session read (B2b), acting only on
 * a parsed reply:
 * - `bridged`: the session JSON for the bridged session, plus the bridged
 *   cookie (after clears of a stale login cookie it replaces; a stale bridged
 *   cookie is simply overwritten). The legacy cookie stays for the rollback
 *   window. The cookie goes on after every other session `Set-Cookie` was
 *   removed.
 * - `denied`: the legacy cookie cannot become a session (signed out, cut off,
 *   replaced, or a rollback cookie of a login row): the read is signed out
 *   (`onDenied`) and the legacy names and chunks are cleared. When this legacy
 *   login was replacing a stale first-party cookie, `onDenied` clears the
 *   first-party names too: the browser's last sign-in ended, so it never falls
 *   back to the older session.
 * These are the session read's three planned exceptions to HARD RULE 2: the
 * bridged cookie, the login-name clears of a replacement, and the clears of a
 * denied legacy cookie.
 * - anything else (503, timeout, 400, the transport's 401), or a client over
 *   its bridge limit: `fallback`, with no cookie change.
 * Never logs the token, the cookie or the reply.
 */
export async function bridgeOnSessionRead(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  legacy: LegacyPresented,
  options: { replaces: 'nothing' | BrowserSessionCookieKind; fallback: BridgeFallback; onDenied: () => Response },
): Promise<Response> {
  const clientKey = trustedClientRateLimitKey(request);
  if (checkRateLimit(`web-session-bridge:${clientKey}`, BRIDGES_PER_CLIENT, BRIDGE_WINDOW_MS).limited)
    return options.fallback();
  const client = createWebSessionCommandClient();
  let bridged: Awaited<ReturnType<typeof client.bridge>>;
  try {
    bridged = await client.bridge(legacy.credential);
  } catch {
    return options.fallback();
  }
  if (bridged.status === 'denied') {
    const answer = options.onDenied();
    appendSignOutSessionCookieClears(
      answer,
      request.cookies.getAll().map((requestCookie) => requestCookie.name),
    );
    return answer;
  }
  // The JSON comes from the backend's own read of the bridged session, so it is
  // exactly what every later read of the bridged cookie answers.
  let read: Awaited<ReturnType<typeof client.read>>;
  try {
    read = await client.read({ kind: 'canonical-token', token: bridged.session.token });
  } catch {
    return options.fallback();
  }
  if (read.status !== 'active' || read.session.authSessionId !== bridged.session.sessionId)
    return NextResponse.json({}, { headers: { ...PRIVATE, [CREDENTIAL_AUTHORITY_HEADER]: 'denied' } });
  const response = NextResponse.json(sessionJson(read.session), { headers: PRIVATE });
  for (const setCookie of bridgedSessionCookies(cookies, bridged.session.token, {
    replacesLoginCookie: options.replaces === 'login',
  }))
    response.headers.append('Set-Cookie', setCookie);
  return response;
}

/** The legacy path's own answer, with every session `Set-Cookie` removed: today's read, no cookie change. */
export function legacyAnswer(legacyRoute: () => Promise<Response>): BridgeFallback {
  return async () => withoutSessionSetCookies(await legacyRoute());
}
