import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { providerSecurityReplyStatus, type ProviderSecurityActor } from '@boardsesh/auth-protocol';
import { resolveBrowserSession } from './browser-session-bridge.server';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import type {
  ProviderSecurityCommandClient,
  ProviderSecurityRefusalReply,
} from './provider-security-command-client.server';

/** What the provider-security routes and callbacks share (#7596 B5e1): their answers and the live session. */

const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;
export const DEFAULT_RETURN_PATH = '/settings';

export type RouteContext = {
  cookies: BrowserSessionCookieConfiguration;
  client: ProviderSecurityCommandClient;
  publicOrigin: string;
};

export function answer(status: number, body: Record<string, unknown>, setCookies: readonly string[] = []): Response {
  const response = NextResponse.json(body, { status, headers: PRIVATE });
  for (const setCookie of setCookies) response.headers.append('Set-Cookie', setCookie);
  return response;
}

export function refusalAnswer(reply: ProviderSecurityRefusalReply, setCookies: readonly string[] = []): Response {
  return answer(
    providerSecurityReplyStatus(reply),
    { status: 'refused', outcome: reply.outcome, code: reply.code },
    setCookies,
  );
}

/** A refusal www answers itself, before or instead of asking the backend. */
export function localRefusal(
  outcome: ProviderSecurityRefusalReply['outcome'],
  code: ProviderSecurityRefusalReply['code'],
  setCookies: readonly string[] = [],
): Response {
  return refusalAnswer(
    {
      providerSecurityVersion: 1,
      requestId: '00000000-0000-4000-8000-000000000000',
      operation: 'methods',
      outcome,
      code,
    },
    setCookies,
  );
}

export function unavailableAnswer(setCookies: readonly string[] = []): Response {
  return answer(503, { status: 'unavailable' }, setCookies);
}

export type LiveSession = { userId: string; authSessionId: string; actor: ProviderSecurityActor };

/**
 * The live first-party session this request presents, read the way the
 * session read and ws-auth read it, but never bridging and never writing a
 * cookie. A legacy-only browser is told to bridge first (the page's own
 * session read does that) and retry: `canonical_session_required`.
 */
export async function liveSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
): Promise<LiveSession | Response> {
  const resolution = await resolveBrowserSession(request, cookies, { bridges: false, bucket: 'session-read' });
  if (resolution.kind === 'unavailable') return unavailableAnswer();
  if (resolution.kind === 'legacy-answer')
    return localRefusal('canonical_session_required', 'canonical_session_required');
  if (resolution.kind === 'signed-out') return localRefusal('unauthenticated', 'invalid_proof');
  const { userId, authSessionId } = resolution.session;
  return {
    userId,
    authSessionId,
    actor: {
      presented: { kind: 'canonical-token', token: resolution.token },
      expectedUserId: userId,
      expectedAuthSessionId: authSessionId,
    },
  };
}

const MAX_BODY_BYTES = 16_384;

/** POST, with this site's `Origin` (and, where the browser sends it, `Sec-Fetch-Site: same-origin`). */
export function sameOriginPost(request: NextRequest, publicOrigin: string): boolean {
  if (request.method !== 'POST') return false;
  if (request.headers.get('origin') !== publicOrigin) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

export async function jsonBody(request: NextRequest): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return undefined;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
