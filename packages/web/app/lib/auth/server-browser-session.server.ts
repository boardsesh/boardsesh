import 'server-only';
import type { BrowserSession } from '@/app/components/providers/session-provider';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { resolveBrowserSession } from './browser-session-bridge.server';
import { browserSessionRouteMode } from './browser-session-mode.server';
import { CredentialAuthorityUnavailable } from './credential-admission.server';
import { createWebSessionCommandClient, type ActiveWebSession } from './web-session-command-client.server';

/**
 * Server renders and private routes under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B4a). Who the browser is comes from `resolveBrowserSession`, the one
 * resolver `/api/auth/session` and ws-auth use, given the request's `Cookie`
 * header exactly as received (Next's cookie store keeps one copy per name, so
 * it would hide the duplicate copies that mean signed out).
 *
 * A render NEVER writes or clears a cookie. A legacy-only browser's first
 * document arrives before any session read: it is bridged without a cookie
 * (the bridge is deterministic, so the session read that follows sets exactly
 * that cookie), in its own budget per client address, and renders signed in.
 * Only reads bridge (a GET or HEAD, page renders and server components); a
 * route's POST or DELETE and a server action answer a legacy-only browser
 * from its admitted legacy cookie, as the session read does for a POST.
 *
 * ONE resolution per request, with its access token, held in a WeakMap keyed
 * by the request's headers object (the same object for every helper call of
 * one request, in a page render, a route handler or a server action; gone
 * with the request). So session and token always come from one resolution,
 * and a request costs one `session` command and one `access` command:
 * - `active`: the session JSON's fields and the backend's 15-minute access
 *   token for that same session. An `access` that finds the session ended
 *   makes the request signed out: never a session without a token.
 * - `signed-out`: a dead first-party cookie, a conflicted one (duplicate
 *   copies included), an oversized or plain-named legacy cookie, a legacy
 *   login the bridge denies, or no cookie.
 * - `legacy`: nothing is known beyond the legacy cookie (its bridge over budget
 *   or failing, or a write request). The session read answers from the legacy
 *   cookie then, and so does the request: session and token both come from
 *   the admitted legacy cookie, as in `legacy` mode.
 * - An unknown mode value, or the backend unavailable: CredentialAuthorityUnavailable,
 *   which each route already answers as its error (503), never as anonymous.
 */
export type ServerBrowserSession =
  | {
      kind: 'active';
      session: ActiveWebSession;
      accessToken: string;
      /**
       * The canonical token the resolution read (from the login or bridged cookie,
       * or the deterministic bridge of a legacy-only read). Server side only: a
       * command that acts for this session presents it (set-password, B4b).
       */
      presentedToken: string;
      /** A newer legacy login sat beside this stale first-party cookie and could not be bridged now. */
      newerLegacyLoginUnresolved: boolean;
    }
  | { kind: 'signed-out' }
  | { kind: 'legacy' };

/** What a helper knows about the request it serves: its method, when a route handler passes it. */
export type ServerRequestFacts = { readonly method?: string };

/** A read may bridge without a cookie; a write (or a server action, which Next marks with `Next-Action`) may not. */
function bridgesFor(incoming: Headers, facts: ServerRequestFacts): boolean {
  if (facts.method !== undefined) return facts.method === 'GET' || facts.method === 'HEAD';
  return !incoming.has('next-action');
}

/** The request the helper serves, from Next's request store: its headers, the `Cookie` header as received, no bearer. */
function renderRequest(incoming: Headers): NextRequest {
  const forwarded = new Headers(incoming);
  // Cookies only: no reader here may fall back to a bearer header.
  forwarded.delete('authorization');
  return new NextRequest('http://server-render.invalid/', { headers: forwarded });
}

async function resolveOnce(incoming: Headers, bridges: boolean): Promise<ServerBrowserSession | undefined> {
  const mode = browserSessionRouteMode();
  if (mode.kind === 'legacy') return undefined;
  if (mode.kind === 'unavailable') throw new CredentialAuthorityUnavailable();
  const resolution = await resolveBrowserSession(renderRequest(incoming), mode.cookies, {
    bridges,
    bucket: 'server-render',
  });
  if (resolution.kind === 'unavailable') throw new CredentialAuthorityUnavailable();
  if (resolution.kind === 'legacy-answer') return { kind: 'legacy' };
  if (resolution.kind === 'signed-out') return { kind: 'signed-out' };
  let access: Awaited<ReturnType<ReturnType<typeof createWebSessionCommandClient>['access']>>;
  try {
    access = await createWebSessionCommandClient().access({ kind: 'canonical-token', token: resolution.token });
  } catch {
    throw new CredentialAuthorityUnavailable();
  }
  // The session ended between the two reads: the request is signed out.
  if (access.status === 'no-session') return { kind: 'signed-out' };
  if (access.status === 'bridge-required') throw new CredentialAuthorityUnavailable();
  const { grant } = access;
  // A token for any other session than the one resolved is never used: that is an outage, not a login.
  if (grant.userId !== resolution.session.userId || grant.authSessionId !== resolution.session.authSessionId)
    throw new CredentialAuthorityUnavailable();
  return {
    kind: 'active',
    session: resolution.session,
    accessToken: grant.accessToken,
    presentedToken: resolution.token,
    newerLegacyLoginUnresolved: resolution.newerLegacyLoginUnresolved === true,
  };
}

/** One resolution per request and kind (read or write), dropped with the request's headers object. */
const heldByRequest = new WeakMap<Headers, Map<boolean, Promise<ServerBrowserSession | undefined>>>();

/**
 * The browser session of the request this helper serves, under `better-auth`;
 * undefined when the mode is `legacy` (the caller keeps the legacy cookie path).
 */
export async function serverBrowserSession(facts: ServerRequestFacts = {}): Promise<ServerBrowserSession | undefined> {
  const incoming = await headers();
  const bridges = bridgesFor(incoming, facts);
  let held = heldByRequest.get(incoming);
  if (!held) {
    held = new Map();
    heldByRequest.set(incoming, held);
  }
  let resolution = held.get(bridges);
  if (!resolution) {
    resolution = resolveOnce(incoming, bridges);
    held.set(bridges, resolution);
  }
  return resolution;
}

/** The NextAuth `Session` shape every caller reads, built from the backend's session read. */
export function sessionFromActive(active: ActiveWebSession): BrowserSession {
  return {
    user: { id: active.userId, name: active.user.name, email: active.user.email, image: active.user.image },
    expires: active.expiresAt,
    authGeneration: active.generation,
    authSessionId: active.authSessionId,
  };
}

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
