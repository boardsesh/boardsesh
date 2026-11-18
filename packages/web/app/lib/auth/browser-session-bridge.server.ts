import 'server-only';
import { decode } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import type { PresentedWebSession } from '@boardsesh/auth-protocol';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { bridgedSessionCookies, readRequestLegacyCookie, withoutSessionSetCookies } from './browser-session.server';
import { CREDENTIAL_AUTHORITY_HEADER } from './credential-admission-response.server';
import { checkRateLimit } from './rate-limiter';
import { appendSignOutSessionCookieClears } from './secure-cookies';
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
 * login-cookie session (coordinator decision (c), B2b): a login made while the
 * mode was `legacy` (a rollback) left the stale first-party login cookie in
 * place. Newer means a different session id and a sign-in time (`auth_time`,
 * else the cookie's issue time) later than the session's `authenticatedAt`.
 * The same session id, an older cookie, an unknown `authenticatedAt`, or a
 * cookie that does not decode: undefined, and the login cookie wins as usual.
 */
export async function newerLegacyLogin(
  request: NextRequest,
  active: ActiveWebSession,
): Promise<LegacyPresented | undefined> {
  if (active.authenticatedAt === null) return undefined;
  const legacy = await readRequestLegacyCookie(request);
  if (legacy.kind !== 'legacy') return undefined;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return undefined;
  let claims: Awaited<ReturnType<typeof decode>>;
  try {
    claims = await decode({ token: legacy.presented.credential, secret });
  } catch {
    return undefined;
  }
  if (!claims) return undefined;
  if (typeof claims.authSessionId === 'string' && claims.authSessionId === active.authSessionId) return undefined;
  const signedInAt = typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat;
  if (typeof signedInAt !== 'number') return undefined;
  return signedInAt * 1000 > Date.parse(active.authenticatedAt) ? legacy.presented : undefined;
}

export type BridgeFallback = () => Promise<Response>;

/**
 * Bridges the request's legacy cookie on a session read (B2b), acting only on
 * a parsed reply:
 * - `bridged`: the session JSON for the bridged session, plus the bridged
 *   cookie (after any clears of a stale login cookie it replaces). The legacy
 *   cookie stays for the rollback window. This is the one session read that
 *   writes a session cookie (HARD RULE 2's planned exception), so the cookie
 *   goes on after every other session `Set-Cookie` was removed.
 * - `denied`: the legacy cookie cannot become a session (signed out, cut off,
 *   replaced, or a rollback cookie of a login row), so its chunks are cleared.
 *   A request with only that cookie reads as signed out; one with an active
 *   login cookie keeps that answer (`onDenied`).
 * - anything else (503, timeout, 400, the transport's 401), or a client over
 *   its bridge limit: `fallback`, with no cookie change.
 * Never logs the token, the cookie or the reply.
 */
export async function bridgeOnSessionRead(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  legacy: LegacyPresented,
  options: { replacesLoginCookie: boolean; fallback: BridgeFallback; onDenied: () => Response },
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
  for (const setCookie of bridgedSessionCookies(cookies, bridged.session.token, options))
    response.headers.append('Set-Cookie', setCookie);
  return response;
}

/** The legacy path's own answer, with every session `Set-Cookie` removed: today's read, no cookie change. */
export function legacyAnswer(legacyRoute: () => Promise<Response>): BridgeFallback {
  return async () => withoutSessionSetCookies(await legacyRoute());
}
