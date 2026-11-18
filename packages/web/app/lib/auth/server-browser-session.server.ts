import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { resolveBrowserSession, type BrowserSessionResolution } from './browser-session-bridge.server';
import { browserSessionRouteMode } from './browser-session-mode.server';
import { CredentialAuthorityUnavailable } from './credential-admission.server';
import { createWebSessionCommandClient, type ActiveWebSession } from './web-session-command-client.server';

/**
 * Server renders and private routes under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B4a). Who the browser is comes from `resolveBrowserSession`, the one
 * resolver `/api/auth/session` and ws-auth use, so a page shows the same login
 * the session JSON does, fallbacks included.
 *
 * A render NEVER writes or clears a cookie. A legacy-only browser's first
 * document arrives before any session read: it is bridged without a cookie
 * (the bridge is deterministic, so the session read that follows sets exactly
 * that cookie), in its own budget per client address, and renders signed in.
 *
 * One resolution and at most one access token per render (React `cache`), so
 * a page can never fetch data as one login and show another:
 * - `active`: the session JSON's fields, and the backend's 15-minute access
 *   token for that same session, fetched once and only when a render asks.
 * - `signed-out`: a dead first-party cookie, a conflicted one, an oversized
 *   legacy cookie, a legacy login the bridge denies, or no cookie.
 * - `legacy`: nothing is known beyond the legacy cookie (bridge over its
 *   budget or failing, an unverifiable first-party cookie beside it, a
 *   plain-named legacy cookie). The session read answers from the legacy
 *   cookie then, and so does the render: session and token both come from the
 *   admitted legacy cookie, as in `legacy` mode.
 * - An unknown mode value, or the backend unavailable: CredentialAuthorityUnavailable,
 *   which each route already answers as its error (503), never as anonymous.
 */
export type ServerBrowserSession =
  | { kind: 'active'; session: ActiveWebSession; token: string }
  | { kind: 'signed-out' }
  | { kind: 'legacy' };

/** The request a render serves, rebuilt from Next's request store: its cookies and its forwarding headers. */
async function renderRequest(): Promise<NextRequest> {
  const [cookieStore, incoming] = await Promise.all([cookies(), headers()]);
  const forwarded = new Headers(incoming);
  // Cookies only: no reader here may fall back to a bearer header.
  forwarded.delete('authorization');
  forwarded.set(
    'cookie',
    cookieStore
      .getAll()
      .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
      .join('; '),
  );
  return new NextRequest('http://server-render.invalid/', { headers: forwarded });
}

function fromResolution(resolution: BrowserSessionResolution): ServerBrowserSession {
  if (resolution.kind === 'unavailable') throw new CredentialAuthorityUnavailable();
  if (resolution.kind === 'legacy-answer') return { kind: 'legacy' };
  if (resolution.kind === 'signed-out') return { kind: 'signed-out' };
  return { kind: 'active', session: resolution.session, token: resolution.token };
}

/**
 * The browser session of this render under `better-auth`, or undefined when
 * the mode is `legacy` (the caller keeps the legacy cookie path, unchanged).
 */
export const serverBrowserSessionForRender = cache(async (): Promise<ServerBrowserSession | undefined> => {
  const mode = browserSessionRouteMode();
  if (mode.kind === 'legacy') return undefined;
  if (mode.kind === 'unavailable') throw new CredentialAuthorityUnavailable();
  const resolution = await resolveBrowserSession(await renderRequest(), mode.cookies, {
    bridges: true,
    bucket: 'server-render',
  });
  return fromResolution(resolution);
});

/** The NextAuth `Session` shape every caller reads, built from the backend's session read. */
export function sessionFromActive(active: ActiveWebSession): Session {
  return {
    user: { id: active.userId, name: active.user.name, email: active.user.email, image: active.user.image },
    expires: active.expiresAt,
    authGeneration: active.generation,
    authSessionId: active.authSessionId,
  };
}

/**
 * The backend's 15-minute access token for the session this render resolved,
 * at most once per render. A token for any other session than the one the
 * page shows is never used: that is an outage, not a login.
 */
export const serverAccessTokenForRender = cache(async (): Promise<string | undefined> => {
  const resolved = await serverBrowserSessionForRender();
  if (resolved?.kind !== 'active') return undefined;
  let access: Awaited<ReturnType<ReturnType<typeof createWebSessionCommandClient>['access']>>;
  try {
    access = await createWebSessionCommandClient().access({ kind: 'canonical-token', token: resolved.token });
  } catch {
    throw new CredentialAuthorityUnavailable();
  }
  // The session ended between the two reads: this render fetches nothing as anyone.
  if (access.status === 'no-session') return undefined;
  if (access.status === 'bridge-required') throw new CredentialAuthorityUnavailable();
  const { grant } = access;
  if (grant.userId !== resolved.session.userId || grant.authSessionId !== resolved.session.authSessionId)
    throw new CredentialAuthorityUnavailable();
  return grant.accessToken;
});

/** The sign-in facts the partner pages show, from the session read rather than the legacy cookie's claims. */
export function partnerSignInFacts(
  active: ActiveWebSession,
  nowMs: number,
): { account: string | null; linkGuarded: boolean; authTimeSeconds: number | null } {
  const signedInAtMs = active.authenticatedAt === null ? Number.NaN : Date.parse(active.authenticatedAt);
  return {
    account: active.user.email || active.user.name || null,
    linkGuarded: active.linkGuarded,
    authTimeSeconds: Number.isFinite(signedInAtMs) ? readAuthTimeClaim(Math.floor(signedInAtMs / 1000), nowMs) : null,
  };
}
