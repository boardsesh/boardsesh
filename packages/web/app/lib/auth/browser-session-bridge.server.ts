import 'server-only';
import { decode } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import type { PresentedWebSession } from '@boardsesh/auth-protocol';
import type { BrowserSessionCookieKind } from '@boardsesh/auth-protocol/browser-session-cookie';
import { isNewerLegacyLogin } from '@boardsesh/auth-protocol/legacy-login-precedence';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import {
  bridgedSessionCookies,
  carriesFirstPartyCookie,
  readRequestBrowserSession,
  readRequestLegacyCookie,
  signOutBrowserSessionCookieClears,
  withoutSessionSetCookies,
  type RequestBrowserSession,
} from './browser-session.server';
import { CREDENTIAL_AUTHORITY_HEADER, unavailableCredentialResponse } from './credential-admission-response.server';
import { checkRateLimit } from './rate-limiter';
import { appendSignOutSessionCookieClears, sessionCookieName } from './secure-cookies';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';
import { createWebSessionCommandClient, type ActiveWebSession } from './web-session-command-client.server';

type LegacyPresented = Extract<PresentedWebSession, { kind: 'legacy-jwe' }>;

/** The private, uncached headers of every session answer. `no-store` on anything that sets the cookie. */
const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * Bridges per client address and minute, counted separately for the session
 * read, ws-auth and server renders, so neither the identity probe nor a page
 * render uses up the session read's.
 * A browser bridges once; a reload loop or a scripted caller stops here.
 */
export const BRIDGES_PER_CLIENT = 20;
/**
 * A browser whose first-party cookie never verifies (another secret, a bad
 * signature) beside a valid legacy cookie is bridged without a cookie on every
 * read and can never get one written (#7792 review, M4b). Its own, higher
 * budget per client, so link prefetches do not turn into an outage of its own.
 */
export const COOKIELESS_BRIDGES_PER_CLIENT = 120;
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
 * Whether decoded NextAuth claims are a newer login than the first-party
 * session (coordinator decision (c), B2b, review H1), by the rule www and the
 * backend share (`@boardsesh/auth-protocol/legacy-login-precedence`, whose
 * vectors www runs too). Only the claim names are mapped here.
 */
export function legacyClaimsWin(
  claims: { readonly authSessionId?: unknown; readonly auth_time?: unknown; readonly iat?: unknown },
  active: Pick<ActiveWebSession, 'authSessionId' | 'authenticatedAt'>,
  cookieKind: BrowserSessionCookieKind,
): boolean {
  return isNewerLegacyLogin(
    { authSessionId: claims.authSessionId, authTime: claims.auth_time, issuedAt: claims.iat },
    { authSessionId: active.authSessionId, authenticatedAt: active.authenticatedAt },
    cookieKind,
  );
}

/**
 * The legacy cookie of this request when it is a newer login than the active
 * first-party session: a login made while the mode was `legacy` (a rollback)
 * wrote only the legacy cookie and left the stale first-party cookie in place.
 * See `isNewerLegacyLogin` for the rule beside a login and beside a bridged
 * cookie. Only the legacy name this deployment writes counts; a cookie that
 * does not decode never wins.
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
  return legacyClaimsWin(claims, active, cookieKind) ? legacy.presented : undefined;
}

/** Who a bridge is counted for: the session read, ws-auth and server renders each have their own budget per client. */
export type BridgeBucket = 'session-read' | 'ws-auth' | 'server-render';

const BRIDGE_LIMIT_PREFIXES: Readonly<Record<BridgeBucket, string>> = Object.freeze({
  'session-read': 'web-session-bridge',
  'ws-auth': 'ws-auth-bridge',
  'server-render': 'server-render-bridge',
});

type BridgeOutcome =
  | { kind: 'bridged'; session: ActiveWebSession; token: string }
  | { kind: 'denied' }
  /** The bridge answered, but the backend's read of the bridged token did not name that session. */
  | { kind: 'mismatch' }
  /** Over the client's limit, 503, a timeout, 400 or the transport's 401: nothing is known. */
  | { kind: 'failed' };

/**
 * Bridges a legacy cookie through the backend (deterministic and idempotent:
 * the same cookie always gets the same token), then reads the bridged session
 * back, acting only on parsed replies. Writes no cookie and logs nothing about
 * the token, the cookie or the reply.
 */
async function bridgeLegacyLogin(
  request: NextRequest,
  legacy: LegacyPresented,
  bucket: BridgeBucket,
  writesNoCookie = false,
): Promise<BridgeOutcome> {
  const clientKey = trustedClientRateLimitKey(request);
  const limitKey = `${BRIDGE_LIMIT_PREFIXES[bucket]}${writesNoCookie ? '-cookieless' : ''}:${clientKey}`;
  const limit = writesNoCookie ? COOKIELESS_BRIDGES_PER_CLIENT : BRIDGES_PER_CLIENT;
  if (checkRateLimit(limitKey, limit, BRIDGE_WINDOW_MS).limited) return { kind: 'failed' };
  const client = createWebSessionCommandClient();
  let bridged: Awaited<ReturnType<typeof client.bridge>>;
  try {
    bridged = await client.bridge(legacy.credential);
  } catch {
    return { kind: 'failed' };
  }
  if (bridged.status === 'denied') return { kind: 'denied' };
  // The answer comes from the backend's own read of the bridged session, so it
  // is exactly what every later read of the bridged cookie answers.
  let read: Awaited<ReturnType<typeof client.read>>;
  try {
    read = await client.read({ kind: 'canonical-token', token: bridged.session.token });
  } catch {
    return { kind: 'failed' };
  }
  if (read.status !== 'active' || read.session.authSessionId !== bridged.session.sessionId) return { kind: 'mismatch' };
  return { kind: 'bridged', session: read.session, token: bridged.session.token };
}

/** Which session cookies a signed-out answer of the session read clears. ws-auth clears none. */
export type SignedOutClears = 'none' | 'legacy' | 'first-party-and-legacy';

/**
 * Who the browser is, under `AUTH_BROWSER_SESSION_MODE=better-auth`: ONE answer
 * for `/api/auth/session` and for `/api/internal/ws-auth` (#7596 B3b), so both
 * name the same `userId` and `authSessionId` for the same request, fallbacks
 * included. The session read turns it into the session JSON and its planned
 * cookie writes; ws-auth turns it into a browser access token and writes no
 * cookie at all.
 *
 * - `active`: a live first-party session and the canonical token that names
 *   it, either from the cookie or from a bridge of the legacy cookie. `bridged`
 *   is set when the session read would set the bridged cookie (and, with
 *   `replaces: 'login'`, clear a stale login cookie).
 * - `signed-out`: with the reason, which decides the session read's clears and
 *   header, and whether ws-auth answers 401 (`session-ended`) or 200.
 * - `legacy-answer`: nothing is known beyond the legacy cookie (a POST, or a
 *   bridge over its limit or failing). The session read answers from the
 *   legacy path as before; ws-auth has no token to give and answers 503.
 *   A plain-named legacy cookie in a secure context is `signed-out` instead,
 *   and an unverifiable first-party cookie beside a valid legacy cookie is
 *   bridged without any cookie write (`active` with no `bridged`), its failed
 *   bridge `unavailable` (#7792 review, M4).
 * - `unavailable`: 503.
 */
export type BrowserSessionResolution =
  | {
      kind: 'active';
      session: ActiveWebSession;
      token: string;
      bridged?: { replaces: 'nothing' | BrowserSessionCookieKind };
      /**
       * This stale first-party session stands because a newer legacy login
       * beside it could not be bridged now (budget or outage). The session
       * read answers it and retries next time; a page that must never name the
       * wrong account (partner consent) treats the browser as signed out.
       */
      newerLegacyLoginUnresolved?: true;
    }
  | {
      kind: 'signed-out';
      reason: 'no-cookie' | 'conflicted' | 'oversized' | 'session-ended' | 'bridge-denied';
      clears: SignedOutClears;
    }
  | { kind: 'legacy-answer' }
  | { kind: 'unavailable' };

/**
 * The one resolver behind the session read and ws-auth. `bridges` is true for
 * a GET: only a GET bridges, and each caller counts its bridges in its own
 * bucket. Never writes a cookie itself.
 */
export async function resolveBrowserSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  { bridges, bucket }: { bridges: boolean; bucket: BridgeBucket },
): Promise<BrowserSessionResolution> {
  let session: RequestBrowserSession;
  try {
    session = await readRequestBrowserSession(request, cookies);
  } catch {
    return { kind: 'unavailable' };
  }
  // A conflicted cookie, or a legacy cookie no command accepts, is signed out.
  if (session.kind === 'conflicted') return { kind: 'signed-out', reason: 'conflicted', clears: 'none' };
  if (session.kind === 'oversized-legacy') return { kind: 'signed-out', reason: 'oversized', clears: 'none' };
  if (session.kind === 'none') return { kind: 'signed-out', reason: 'no-cookie', clears: 'none' };
  if (session.kind === 'legacy') {
    // A legacy cookie under a name this deployment does not write (the plain
    // name in a secure context) is signed out everywhere, as NextAuth reads
    // only the `__Secure-` name in production today (#7792 review, M4a).
    if (session.cookieName !== sessionCookieName()) return { kind: 'signed-out', reason: 'no-cookie', clears: 'none' };
    if (!bridges) return { kind: 'legacy-answer' };
    // A first-party cookie that does not verify (another secret, a bad
    // signature) beside a valid legacy cookie: a legacy-only browser that may
    // never get a cookie written (M4b). It is bridged without one; a denial is
    // signed out with nothing cleared, and an outage is an outage.
    const writesNoCookie = carriesFirstPartyCookie(request);
    const outcome = await bridgeLegacyLogin(request, session.presented, bucket, writesNoCookie);
    if (outcome.kind === 'bridged')
      return writesNoCookie
        ? { kind: 'active', session: outcome.session, token: outcome.token }
        : { kind: 'active', session: outcome.session, token: outcome.token, bridged: { replaces: 'nothing' } };
    if (outcome.kind === 'denied')
      return { kind: 'signed-out', reason: 'bridge-denied', clears: writesNoCookie ? 'none' : 'legacy' };
    if (outcome.kind === 'mismatch') return { kind: 'signed-out', reason: 'session-ended', clears: 'none' };
    return writesNoCookie ? { kind: 'unavailable' } : { kind: 'legacy-answer' };
  }
  let active: ActiveWebSession;
  try {
    const read = await createWebSessionCommandClient().read(session.presented);
    if (read.status === 'signed-out') return { kind: 'signed-out', reason: 'session-ended', clears: 'none' };
    active = read.session;
    if (active.user.id !== active.userId) return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
  const fromCookie: BrowserSessionResolution = { kind: 'active', session: active, token: session.presented.token };
  if (!bridges) return fromCookie;
  let newer: Awaited<ReturnType<typeof newerLegacyLogin>>;
  try {
    newer = await newerLegacyLogin(request, active, session.cookieKind);
  } catch {
    newer = undefined;
  }
  if (!newer) return fromCookie;
  const outcome = await bridgeLegacyLogin(request, newer, bucket);
  if (outcome.kind === 'bridged')
    return {
      kind: 'active',
      session: outcome.session,
      token: outcome.token,
      bridged: { replaces: session.cookieKind },
    };
  // The newer login ended: signed out, never back to the stale session.
  if (outcome.kind === 'denied')
    return { kind: 'signed-out', reason: 'bridge-denied', clears: 'first-party-and-legacy' };
  if (outcome.kind === 'mismatch') return { kind: 'signed-out', reason: 'session-ended', clears: 'none' };
  // A failed bridge keeps this request's answer; the next read retries.
  return { kind: 'active', session: active, token: session.presented.token, newerLegacyLoginUnresolved: true };
}

/**
 * The session read's answer for a resolution (B2b): the session JSON and the
 * session read's three planned exceptions to HARD RULE 2: the bridged cookie
 * (after clears of a stale login cookie it replaces; a stale bridged cookie is
 * simply overwritten), and the clears of a denied legacy cookie (plus the
 * first-party names when that legacy login was replacing a stale first-party
 * cookie, so the browser never falls back to the older session). The legacy
 * cookie stays after a bridge, for the rollback window. Every answer is
 * `private, no-store`.
 */
export async function sessionReadAnswer(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  resolution: BrowserSessionResolution,
  legacyRoute: () => Promise<Response>,
): Promise<Response> {
  if (resolution.kind === 'unavailable') return unavailableCredentialResponse();
  if (resolution.kind === 'legacy-answer') return withoutSessionSetCookies(await legacyRoute());
  if (resolution.kind === 'signed-out') {
    const ended = resolution.reason === 'session-ended';
    const answer = NextResponse.json(
      {},
      { headers: ended ? { ...PRIVATE, [CREDENTIAL_AUTHORITY_HEADER]: 'denied' } : PRIVATE },
    );
    const carriedNames = request.cookies.getAll().map((requestCookie) => requestCookie.name);
    if (resolution.clears === 'first-party-and-legacy')
      for (const clear of signOutBrowserSessionCookieClears(cookies, carriedNames))
        answer.headers.append('Set-Cookie', clear);
    if (resolution.clears !== 'none') appendSignOutSessionCookieClears(answer, carriedNames);
    return answer;
  }
  const answer = NextResponse.json(sessionJson(resolution.session), { headers: PRIVATE });
  if (resolution.bridged)
    for (const setCookie of bridgedSessionCookies(cookies, resolution.token, resolution.session.authSessionId, {
      replacesLoginCookie: resolution.bridged.replaces === 'login',
    }))
      answer.headers.append('Set-Cookie', setCookie);
  return answer;
}
