import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { safeCallbackUrl } from '@/app/auth/signout/safe-callback-url';
import { resolveBrowserSession } from './browser-session-bridge.server';
import { browserSessionRouteMode } from './browser-session-mode.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { requireExpectedViewer } from './expected-viewer.server';
import {
  REAUTHENTICATION_MAX_AGE_SECONDS,
  clearReauthenticationCookie,
  readReauthenticationCookie,
  sealReauthenticationCookie,
} from './reauthentication-cookie.server';

const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: PRIVATE });

function redirect(publicOrigin: string, path: string, setCookie: string): Response {
  const response = new Response(null, {
    status: 303,
    headers: { Location: new URL(path, publicOrigin).href, ...PRIVATE, 'Referrer-Policy': 'no-referrer' },
  });
  response.headers.append('Set-Cookie', setCookie);
  return response;
}

/**
 * `/api/auth/reauthenticate/start` (POST) and `/return` (GET), the two ends of
 * the forced re-sign-in (#7655 item 6) under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (404 otherwise). `start` records who is signed in and the return path in a
 * sealed cookie; the sign-in (password or Google) then comes back to
 * `return`, which forwards to that path only when the browser is signed in as
 * the same account. Neither writes or clears a session cookie.
 */
export async function routeReauthentication(request: NextRequest, action: string): Promise<Response> {
  const mode = browserSessionRouteMode();
  if (mode.kind === 'legacy') return json(404, { error: 'not_found' });
  if (mode.kind === 'unavailable') return json(503, { status: 'unavailable' });
  const publicOrigin = resolvePublicAuthOrigin() ?? request.nextUrl.origin;
  // The raw Cookie header, never bridging and never writing a session cookie.
  const resolution = await resolveBrowserSession(request, mode.cookies, { bridges: false, bucket: 'session-read' });
  if (resolution.kind === 'unavailable') return json(503, { status: 'unavailable' });
  const session =
    resolution.kind === 'active'
      ? { user: { id: resolution.session.userId }, authSessionId: resolution.session.authSessionId }
      : null;
  const userId = session?.user.id;

  if (action === 'start' && request.method === 'POST') {
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== publicOrigin || (site !== null && site !== 'same-origin'))
      return json(403, { error: 'origin_refused' });
    const viewerChanged = requireExpectedViewer(request, session, {
      route: '/api/auth/reauthenticate/start',
      missing: 'reject',
    });
    if (viewerChanged) return viewerChanged;
    if (resolution.kind === 'legacy-answer')
      return json(403, { status: 'refused', outcome: 'canonical_session_required' });
    if (!userId) return json(401, { status: 'signed_out' });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const callbackUrl = body && typeof body === 'object' ? (body as { callbackUrl?: unknown }).callbackUrl : undefined;
    const response = json(200, { status: 'started' });
    response.headers.append(
      'Set-Cookie',
      sealReauthenticationCookie(mode.cookies, {
        version: 1,
        startedAs: userId,
        returnTo: safeCallbackUrl(typeof callbackUrl === 'string' ? callbackUrl : undefined),
        expiresAt: Date.now() + REAUTHENTICATION_MAX_AGE_SECONDS * 1000,
      }),
    );
    return response;
  }

  if (action === 'return' && request.method === 'GET') {
    const record = readReauthenticationCookie(request.headers.get('cookie'), mode.cookies);
    const clear = clearReauthenticationCookie(mode.cookies);
    if (!record) return redirect(publicOrigin, '/auth/reauthenticate?outcome=expired', clear);
    // Another account came back (Google offered a different one): never forward.
    if (!userId || userId !== record.startedAs)
      return redirect(publicOrigin, '/auth/reauthenticate?outcome=other_account', clear);
    return redirect(publicOrigin, record.returnTo, clear);
  }
  return json(404, { error: 'not_found' });
}
