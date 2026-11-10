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
 * <provider>`), because only there is this flow's own callback URL known.
 *
 * At the start: a callback-url cookie the response sets, else the `callbackUrl`
 * the request itself posted (read by `readSignInStartCallbackUrl` before NextAuth
 * consumes the body). A start refused before NextAuth runs, such as a
 * `backend-staging` 503, sets no cookie, and the base cookie is not this flow's.
 *
 * At the callback:
 * 1. a callback-url cookie the same response sets, else
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

type FlowLeg = 'start' | 'end';

/**
 * This flow's own callback URL, or null when it cannot be known for certain.
 * See the module comment for the order on each leg.
 */
function flowCallbackUrl(
  request: NextRequest,
  response: Response,
  leg: FlowLeg,
  startCallbackUrl: string | null,
): string | null {
  const nowMs = Date.now();
  const written = response.headers
    .getSetCookie()
    .map((header) => parseSetCookie(header))
    .filter((cookie) => callbackUrlCookie(cookie.name) !== null);

  const set = written.find((cookie) => !isRetired(cookie, nowMs));
  if (set?.value) return set.value;
  // A staged start also retires OLDER flows' cookies, so neither the retired
  // cookies nor the base cookie say anything about this one.
  if (leg === 'start') return startCallbackUrl;

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

function flowLeg(request: NextRequest): FlowLeg | null {
  const { pathname } = request.nextUrl;
  if (request.method === 'POST' && FLOW_START.test(pathname)) return 'start';
  return FLOW_END.test(pathname) ? 'end' : null;
}

/** Sign-in start bodies are a few hundred bytes; anything bigger is not one to read. */
const MAX_START_BODY_BYTES = 16 * 1024;
/** `boundedText` in web-oauth-request.server.ts: a body that stalls never holds the route. */
const START_BODY_DEADLINE_MS = 2000;

const TIMED_OUT = Symbol('timed out');

/** The body as text, or null when it is over the cap, stalls past the deadline or cannot be read. */
async function boundedStartBody(request: NextRequest): Promise<string | null> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_START_BODY_BYTES) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), START_BODY_DEADLINE_MS);
  });
  // A tee branch's cancel settles only once NextAuth's branch ends too, so never wait on it.
  const abandon = () => {
    void reader.cancel().catch(() => {});
    return null;
  };
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === TIMED_OUT) return abandon();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_START_BODY_BYTES) return abandon();
      chunks.push(chunk.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `Object.fromEntries` keeps the last of a repeated name, and so does NextAuth. */
function lastValue(search: URLSearchParams, name: string): string | undefined {
  return search.getAll(name).at(-1);
}

/**
 * The `callbackUrl` a sign-in start posted, read from a clone before NextAuth
 * consumes the body, and parsed the way next-auth 4.24's App Router handler does
 * so the two always agree: `getBody` (`next-auth/next/utils.js`) takes JSON when
 * the content type `includes('application/json')`, else a form when it includes
 * `application/x-www-form-urlencoded` (both case-sensitive, last duplicate wins),
 * and `core/index.js` uses `body.callbackUrl ?? query.callbackUrl`. Null for any
 * other request, or a body that is too big, stalls or does not parse.
 */
export async function readSignInStartCallbackUrl(request: NextRequest): Promise<string | null> {
  if (flowLeg(request) !== 'start') return null;
  const fromQuery = lastValue(request.nextUrl.searchParams, 'callbackUrl');
  const contentType = request.headers.get('content-type');
  const kind = contentType?.includes('application/json')
    ? 'json'
    : contentType?.includes('application/x-www-form-urlencoded')
      ? 'form'
      : null;

  let fromBody: unknown;
  if (request.body && kind) {
    const text = await boundedStartBody(request);
    if (text === null) return null;
    if (kind === 'form') {
      fromBody = lastValue(new URLSearchParams(text), 'callbackUrl');
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // NextAuth's own `req.json()` throws here too: the start fails before any redirect.
        return null;
      }
      if (typeof parsed === 'object' && parsed !== null) fromBody = (parsed as Record<string, unknown>).callbackUrl;
    }
  }
  const callbackUrl = fromBody ?? fromQuery;
  return typeof callbackUrl === 'string' && callbackUrl ? callbackUrl : null;
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

/**
 * The response, or the same answer pointed back at the partner sign-in page.
 * `startCallbackUrl` is what `readSignInStartCallbackUrl` read from this request.
 */
export async function withPartnerSignInFailureReturn(
  request: NextRequest,
  response: Response,
  startCallbackUrl: string | null = null,
): Promise<Response> {
  const leg = flowLeg(request);
  if (!leg) return response;

  if (response.status >= 300 && response.status < 400) {
    const destination = errorDestination(response.headers.get('Location'));
    if (!destination) return response;
    const partnerPath = partnerReturnFor(destination, flowCallbackUrl(request, response, leg, startCallbackUrl));
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
  const partnerPath = partnerReturnFor(destination, flowCallbackUrl(request, response, leg, startCallbackUrl));
  if (!partnerPath) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  // Absolute, on the origin NextAuth itself named: next-auth/react parses it with `new URL`.
  const absolute = new URL(partnerPath, URL.canParse(url) ? url : request.url);
  return Response.json({ ...body, url: absolute.href }, { status: response.status, headers });
}
