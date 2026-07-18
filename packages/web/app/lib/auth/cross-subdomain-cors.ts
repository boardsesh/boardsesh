import { NextResponse, type NextRequest } from 'next/server';
import { APP_URL } from '@/app/lib/app-origin';

// Credentialed cross-origin CORS for the standalone Expo-web app.
//
// app.boardsesh.com is served as a static SPA on its own origin. It reads the
// shared `.boardsesh.com` NextAuth session by calling www.boardsesh.com's auth
// endpoints cross-origin *with credentials* (`credentials: 'include'`), so those
// responses need explicit, credentialed CORS headers. A credentialed request
// forbids `Access-Control-Allow-Origin: *` — the Origin must be echoed exactly.
//
// Only the endpoints the app actually calls cross-origin are exposed; keep this
// set tight so no other route grows an ambient-credential CORS surface.
const CORS_AUTH_PATHS = new Set([
  '/api/auth/session',
  '/api/auth/csrf',
  '/api/auth/callback/credentials',
  '/api/auth/signout',
  '/api/internal/ws-auth',
]);

// The exact app origin (env-overridable via NEXT_PUBLIC_APP_URL; prod default
// https://app.boardsesh.com).
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return null;
  }
})();

// …plus numbered homelab previews (https://{N}.app.boardsesh.com), mirroring the
// backend CORS allow-list (packages/backend/src/handlers/cors.ts). Both checks
// are origin-anchored — a `URL.origin` is scheme+host+port with no path, and the
// regex is `^…$`-anchored — so look-alikes like https://app.boardsesh.com.evil.com
// or https://evil-app.boardsesh.com never match.
const APP_PREVIEW_ORIGIN_REGEX = /^https:\/\/\d+\.app\.boardsesh\.com$/;

// The Expo-web credentials/signout POSTs carry a non-safelisted request header
// (`X-Auth-Return-Redirect`) alongside the form content-type, so both must be
// named here or the browser preflight fails. `Accept` is CORS-safelisted and
// needs no listing.
const ALLOWED_REQUEST_HEADERS = 'content-type, x-auth-return-redirect';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

export function isAllowedAppOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  if (APP_ORIGIN !== null && origin === APP_ORIGIN) return true;
  return APP_PREVIEW_ORIGIN_REGEX.test(origin);
}

type CrossSubdomainAuthCors = { preflight: NextResponse } | { applyHeaders: (response: NextResponse) => void };

/**
 * Resolve cross-subdomain CORS handling for a request to one of the Expo-web
 * auth endpoints. Returns:
 *   • `{ preflight }`   — an OPTIONS request from an allowed app origin; return
 *     it directly (204, credentialed CORS headers, no body).
 *   • `{ applyHeaders }` — a same-endpoint GET/POST from an allowed app origin;
 *     call it on the final response to attach the credentialed CORS headers.
 *   • `null` — not CORS-relevant: a non-auth path, or an origin that isn't an
 *     allowed app origin (including same-origin www requests, which need no
 *     CORS). The caller proceeds normally and NO `Access-Control-*` is added.
 */
export function resolveCrossSubdomainAuthCors(request: NextRequest): CrossSubdomainAuthCors | null {
  if (!CORS_AUTH_PATHS.has(request.nextUrl.pathname)) return null;
  const origin = request.headers.get('origin');
  if (!isAllowedAppOrigin(origin)) return null;

  const setCorsHeaders = (headers: Headers) => {
    // Echo the exact origin (never `*`) — required for credentialed CORS — and
    // Vary on Origin so a cached response isn't reused for a different origin.
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.append('Vary', 'Origin');
  };

  if (request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204 });
    setCorsHeaders(preflight.headers);
    preflight.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    preflight.headers.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
    return { preflight };
  }

  return { applyHeaders: (response) => setCorsHeaders(response.headers) };
}
