import { NextResponse, type NextRequest } from 'next/server';
import { isAllowedAppOrigin } from '@/app/lib/auth/app-origin-allowlist';

// Credentialed cross-origin CORS for the standalone Expo-web app.
//
// app.boardsesh.com is served as a static SPA on its own origin. It reads the
// shared `.boardsesh.com` NextAuth session — and runs the credentials sign-in,
// registration, and password-reset flows — by calling www.boardsesh.com's auth
// endpoints cross-origin *with credentials* (`credentials: 'include'`), so those
// responses need explicit, credentialed CORS headers. A credentialed request
// forbids `Access-Control-Allow-Origin: *` — the Origin must be echoed exactly.
//
// Only the endpoints the app actually calls cross-origin are exposed; keep this
// set tight so no other route grows an ambient-credential CORS surface.
const CORS_AUTH_PATHS = new Set([
  '/api/auth/session',
  // The Expo-web login/register screens discover which configured providers
  // should be offered before starting a browser OAuth redirect.
  '/api/auth/providers-config',
  '/api/auth/csrf',
  '/api/auth/callback/credentials',
  '/api/auth/signout',
  '/api/internal/ws-auth',
  // Reachable from the app's login screen (Sign up / Forgot password links) and
  // the reset-password deep link, all POSTed cross-origin from app.boardsesh.com.
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  // The register screen's "Resend verification email" recovery button.
  '/api/auth/resend-verification',
]);

// The Expo-web credentials/signout POSTs carry a non-safelisted request header
// (`X-Auth-Return-Redirect`) alongside the form content-type, so both must be
// named here or the browser preflight fails. `Accept` is CORS-safelisted and
// needs no listing.
const ALLOWED_REQUEST_HEADERS = 'content-type, x-auth-return-redirect';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
// One day — the browser caps this per its own ceiling (600s in Chromium), but a
// generous value keeps the preflight cached across the whole sign-in sequence.
const PREFLIGHT_MAX_AGE_SECONDS = '86400';

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
    // Cache the preflight for a day so the app's sequential credentialed
    // sign-in calls (csrf → callback → session → ws-auth) don't each re-preflight.
    preflight.headers.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    return { preflight };
  }

  return { applyHeaders: (response) => setCorsHeaders(response.headers) };
}
