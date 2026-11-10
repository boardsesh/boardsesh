import type { NextRequest } from 'next/server';
import { parseSetCookie } from 'cookie';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import {
  MAX_PARTNER_QUERY_LENGTH,
  PARTNER_SIGN_IN_PATH,
  SIGN_IN_ERROR_PARAMETER,
  SIGNED_IN_PARAMETER,
} from './authorization-query';

/**
 * Keeps a failed Google, Apple or Facebook sign-in on `/oauth/sign-in`.
 *
 * NextAuth sends a failed social sign-in through `/api/auth/error` and
 * `/api/auth/signin` to `pages.signIn` (`/auth/login?error=…`), or to
 * `pages.error` (`/auth/error?error=…`) for the few codes outside its sign-in
 * list. Both lose the app's request, and `/auth/login` is a universal link the
 * iPhone app claims (verification links rely on that), so the climber would be
 * dropped into the app halfway through connecting a partner.
 *
 * The decision is made once, on the response that starts the provider round
 * trip (`POST /api/auth/signin/<provider>`) or ends it (`/api/auth/callback/
 * <provider>`), because only there is this flow's own callback URL known:
 *
 * 1. a callback-url cookie the same response sets (a sign-in start), else
 * 2. the flow-scoped `<callback-url>.<scope>` cookie the response retires
 *    (`CURRENT_STORE_WEB_OAUTH_MODE=backend-staging`), else
 * 3. with no scoped cookie in the request at all, the base callback-url cookie,
 *    which the legacy sign-in start wrote for this flow.
 *
 * The base cookie is never read once flows are scoped, and the later hops
 * (`/api/auth/error`, `/api/auth/signin`) are never rewritten: by then the base
 * cookie can be stale, for example one kept from "Not you? Sign out" on the
 * partner page, and would send an ordinary failed sign-in to an old partner
 * request. When the flow started on the partner page, the first error redirect
 * (or a sign-in start's JSON `url`) goes straight back there with the error code.
 * Only that page's path is ever written, never another origin.
 */

/** NextAuth's error hops and the two pages they end on (`pages.signIn`, `pages.error`). */
const ERROR_DESTINATIONS: ReadonlySet<string> = new Set([
  '/api/auth/error',
  '/api/auth/signin',
  '/auth/login',
  '/auth/error',
]);

const CALLBACK_URL_COOKIE_NAMES: readonly string[] = ['__Secure-next-auth.callback-url', 'next-auth.callback-url'];
/** `scopedWebOAuthCookies` in web-oauth-continuation.server.ts: `<name>.<32 hex>`. */
const FLOW_SCOPE = /^[a-f0-9]{32}$/;

/** The requests that start or end a provider round trip, under an optional locale segment. */
const FLOW_START = /^(?:\/[A-Za-z-]{2,5})?\/api\/auth\/signin\/[^/]+\/?$/;
const FLOW_END = /^(?:\/[A-Za-z-]{2,5})?\/api\/auth\/callback\/[^/]+\/?$/;

const LOCALE_SEGMENTS = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);
const PARTNER_SIGN_IN_PATHNAME = new RegExp(`^(?:/(?:${LOCALE_SEGMENTS.join('|')}))?${PARTNER_SIGN_IN_PATH}$`);

/** NextAuth's codes are words; anything else is passed on as its generic failure. */
const ERROR_CODE = /^[A-Za-z]{1,64}$/;
const GENERIC_ERROR_CODE = 'OAuthCallback';

/** Only parses: tells a relative path from an absolute URL without trusting either. */
const PARSING_ORIGIN = 'https://partner-sign-in-return.invalid';

/** The sign-in page path and query a candidate names, or null when it names anything else. */
export function partnerSignInReturnPath(candidate: string | null | undefined): URL | null {
  if (!candidate || candidate.length > MAX_PARTNER_QUERY_LENGTH + 256) return null;
  let url: URL;
  try {
    url = new URL(candidate, PARSING_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.hash) return null;
  return PARTNER_SIGN_IN_PATHNAME.test(url.pathname) ? url : null;
}

/** `<base>` or `<base>.<scope>` for a callback-url cookie, else null. */
function callbackUrlCookie(name: string): { base: string; scope: string | null } | null {
  for (const base of CALLBACK_URL_COOKIE_NAMES) {
    if (name === base) return { base, scope: null };
    if (name.startsWith(`${base}.`) && FLOW_SCOPE.test(name.slice(base.length + 1))) {
      return { base, scope: name.slice(base.length + 1) };
    }
  }
  return null;
}

function isRetired(cookie: { value?: string; maxAge?: number; expires?: Date }, nowMs: number): boolean {
  return (
    !cookie.value ||
    (cookie.maxAge !== undefined && cookie.maxAge <= 0) ||
    (cookie.expires !== undefined && cookie.expires.getTime() <= nowMs)
  );
}

/**
 * This flow's own callback URL, or null when it cannot be known for certain.
 * See the module comment for the order.
 */
function flowCallbackUrl(request: NextRequest, response: Response): string | null {
  const nowMs = Date.now();
  const written = response.headers
    .getSetCookie()
    .map((header) => parseSetCookie(header))
    .filter((cookie) => callbackUrlCookie(cookie.name) !== null);

  const set = written.find((cookie) => !isRetired(cookie, nowMs));
  if (set?.value) return set.value;

  const retiredScoped = written.find((cookie) => callbackUrlCookie(cookie.name)?.scope && isRetired(cookie, nowMs));
  if (retiredScoped) return request.cookies.get(retiredScoped.name)?.value ?? null;

  const requestCookies = request.cookies.getAll();
  if (requestCookies.some((cookie) => callbackUrlCookie(cookie.name)?.scope)) return null;
  for (const base of CALLBACK_URL_COOKIE_NAMES) {
    const legacy = request.cookies.get(base)?.value;
    if (legacy) return legacy;
  }
  return null;
}

function isFlowBoundary(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return (request.method === 'POST' && FLOW_START.test(pathname)) || FLOW_END.test(pathname);
}

/** An error destination NextAuth names, or null. */
function errorDestination(target: string | null): URL | null {
  if (!target) return null;
  try {
    const destination = new URL(target, PARSING_ORIGIN);
    if (!ERROR_DESTINATIONS.has(destination.pathname)) return null;
    return destination.searchParams.has(SIGN_IN_ERROR_PARAMETER) ? destination : null;
  } catch {
    return null;
  }
}

/** The partner page path to send the browser to instead, with the error code. */
function partnerReturnFor(destination: URL, callbackUrl: string | null): string | null {
  const partnerReturn = partnerSignInReturnPath(callbackUrl);
  if (!partnerReturn) return null;
  const errorCode = destination.searchParams.get(SIGN_IN_ERROR_PARAMETER) ?? '';
  partnerReturn.searchParams.delete(SIGNED_IN_PARAMETER);
  partnerReturn.searchParams.set(SIGN_IN_ERROR_PARAMETER, ERROR_CODE.test(errorCode) ? errorCode : GENERIC_ERROR_CODE);
  return `${partnerReturn.pathname}${partnerReturn.search}`;
}

async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) return null;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The response, or the same answer pointed back at the partner sign-in page. */
export async function withPartnerSignInFailureReturn(request: NextRequest, response: Response): Promise<Response> {
  if (!isFlowBoundary(request)) return response;

  if (response.status >= 300 && response.status < 400) {
    const destination = errorDestination(response.headers.get('Location'));
    if (!destination) return response;
    const partnerPath = partnerReturnFor(destination, flowCallbackUrl(request, response));
    if (!partnerPath) return response;
    const headers = new Headers(response.headers);
    headers.set('Location', partnerPath);
    return new Response(null, { status: response.status, headers });
  }

  // A sign-in start the browser called with `json: true` answers `{ url }`.
  const body = await jsonBody(response);
  const url = typeof body?.url === 'string' ? body.url : null;
  const destination = errorDestination(url);
  if (!body || !url || !destination) return response;
  const partnerPath = partnerReturnFor(destination, flowCallbackUrl(request, response));
  if (!partnerPath) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  // Absolute, on the origin NextAuth itself named: next-auth/react parses it with `new URL`.
  const absolute = new URL(partnerPath, URL.canParse(url) ? url : request.url);
  return Response.json({ ...body, url: absolute.href }, { status: response.status, headers });
}
