import 'server-only';
import type { NextRequest } from 'next/server';
import { LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH, type PresentedWebSession } from '@boardsesh/auth-protocol';
import {
  browserSessionCookieClears,
  browserSessionCookieName,
  readBrowserSessionCookies,
  serializeBrowserSessionCookie,
  serializeViewerMarkerCookie,
  type BrowserSessionCookieKind,
} from '@boardsesh/auth-protocol/browser-session-cookie';
import { viewerMarkerCookieName } from '@boardsesh/auth-protocol/viewer-marker';
import { webLogger } from '@/app/lib/observability/logger';
import { capturePresentedWebCredential } from './admitted-session.server';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import {
  PLAIN_SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  isSecureCookieContext,
  sessionCookieDomain,
} from './secure-cookies';

/**
 * The session a request arrived with, under `AUTH_BROWSER_SESSION_MODE=better-auth`.
 *
 * - `canonical`: a verified first-party cookie. The login cookie outranks the
 *   bridged one. `cookieKind` says which name carried it; it decides only
 *   which cookie a newer legacy login replaces (B2b), never anything about the
 *   session, whose freshness and source come from the backend's row.
 * - `conflicted`: the login cookie, or (with no verified login cookie) the
 *   bridged cookie, or the legacy cookie arrived as differing copies of one
 *   name. The browser is signed out; no other cookie stands in for it, and
 *   nothing is bridged. A login still presents the legacy cookie from the same
 *   request when that one is not itself conflicted, so the session it names ends.
 * - `legacy`: no verified first-party cookie, and a NextAuth cookie no longer
 *   than the command accepts.
 * - `oversized-legacy`: a NextAuth cookie longer than any command accepts. It
 *   reads as signed out and is never sent to the backend.
 * - `none`.
 */
type LegacyPresented = Extract<PresentedWebSession, { kind: 'legacy-jwe' }>;
export type RequestBrowserSession =
  | {
      kind: 'canonical';
      cookieKind: BrowserSessionCookieKind;
      presented: Extract<PresentedWebSession, { kind: 'canonical-token' }>;
    }
  | { kind: 'conflicted'; legacy: LegacyPresented | undefined }
  /** `cookieName`: the name it arrived under; only the name this deployment writes is ever bridged. */
  | { kind: 'legacy'; presented: LegacyPresented; cookieName: string }
  | { kind: 'oversized-legacy' }
  | { kind: 'none' };

type LegacyRead =
  | { kind: 'legacy'; presented: LegacyPresented; cookieName: string }
  | { kind: 'oversized-legacy' }
  | { kind: 'none' };

const LEGACY_BASE_NAMES = [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME];

/** A legacy NextAuth session cookie name, either spelling, or one of its numbered chunks. */
export function isLegacyCookieName(name: string): boolean {
  return LEGACY_BASE_NAMES.some(
    (base) => name === base || (/^\.\d+$/.test(name.slice(base.length)) && name.startsWith(base)),
  );
}

/** Pairs of the `Cookie` header as received, split as a browser sends them; only space and tab are stripped. */
function cookiePairs(cookieHeader: string | null): { name: string; value: string }[] {
  if (!cookieHeader) return [];
  return cookieHeader.split(';').flatMap((pair) => {
    const separator = pair.indexOf('=');
    if (separator === -1) return [];
    return [
      {
        name: pair.slice(0, separator).replace(/^[ \t]+|[ \t]+$/g, ''),
        value: pair.slice(separator + 1).replace(/^[ \t]+|[ \t]+$/g, ''),
      },
    ];
  });
}

/**
 * Legacy cookies a reader cannot tell apart reliably, so the browser reads as
 * signed out and nothing is bridged:
 * - one name (or chunk) sent twice with differing values: a host-only copy left
 *   from before the shared domain beside the Domain one;
 * - a base name beside chunk names of the same family, which NextAuth would
 *   join in no defined order;
 * - the `__Secure-` and the plain family both present with differing values.
 */
function legacyCookieConflicted(cookieHeader: string | null): boolean {
  const families = new Map<string, Map<string, string>>();
  for (const { name, value } of cookiePairs(cookieHeader)) {
    const base = LEGACY_BASE_NAMES.find((candidate) => name === candidate || name.startsWith(`${candidate}.`));
    if (!base || !isLegacyCookieName(name)) continue;
    const family = families.get(base) ?? new Map<string, string>();
    families.set(base, family);
    const earlier = family.get(name);
    if (earlier !== undefined && earlier !== value) return true;
    family.set(name, value);
  }
  for (const [base, family] of families)
    if (family.has(base) && [...family.keys()].some((name) => name !== base)) return true;
  if (families.size > 1) {
    const [first, second] = [...families.values()].map((family) => JSON.stringify([...family.values()]));
    if (first !== second) return true;
  }
  return false;
}

/** Whether the request carried a first-party session cookie of either name, in either spelling, verified or not. */
export function carriesFirstPartyCookie(request: NextRequest): boolean {
  const names = new Set(
    (['login', 'bridged'] as const).flatMap((kind) =>
      [true, false].map((secure) => browserSessionCookieName(kind, secure)),
    ),
  );
  return cookiePairs(request.headers.get('cookie')).some(({ name }) => names.has(name));
}

async function readLegacyCookie(request: NextRequest): Promise<LegacyRead | { kind: 'conflicted'; legacy: undefined }> {
  if (legacyCookieConflicted(request.headers.get('cookie'))) {
    webLogger.warn('browser session cookie conflicted', { kinds: 'legacy' });
    return { kind: 'conflicted', legacy: undefined };
  }
  const legacy = await capturePresentedWebCredential(request);
  if (!legacy) return { kind: 'none' };
  if (legacy.credential.length > LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH) return { kind: 'oversized-legacy' };
  return {
    kind: 'legacy',
    presented: { kind: 'legacy-jwe', credential: legacy.credential },
    cookieName: legacy.cookieName,
  };
}

/**
 * Reads the request's session cookies. The `Cookie` header is passed to the
 * codec exactly as received. Throws only when the legacy cookie cannot be
 * reassembled (`CredentialAuthorityUnavailable`), which callers answer as 503.
 */
export async function readRequestBrowserSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
): Promise<RequestBrowserSession> {
  const read = readBrowserSessionCookies(request.headers.get('cookie'), cookies.secret, cookies.secure);
  const conflictedFirstParty =
    read.conflicted.includes('login') || (read.login === undefined && read.conflicted.includes('bridged'));
  if (conflictedFirstParty) {
    webLogger.warn('browser session cookie conflicted', { kinds: read.conflicted.join(',') });
    const legacy = await readLegacyCookie(request);
    return { kind: 'conflicted', legacy: legacy.kind === 'legacy' ? legacy.presented : undefined };
  }
  if (read.login !== undefined)
    return { kind: 'canonical', cookieKind: 'login', presented: { kind: 'canonical-token', token: read.login } };
  if (read.bridged !== undefined)
    return { kind: 'canonical', cookieKind: 'bridged', presented: { kind: 'canonical-token', token: read.bridged } };
  return readLegacyCookie(request);
}

/** The legacy cookie of a request, read as `readRequestBrowserSession` reads it when no first-party cookie is there. */
export const readRequestLegacyCookie = readLegacyCookie;

/** What a login presents for revocation, or undefined for nothing. */
export function presentedForLogin(session: RequestBrowserSession): PresentedWebSession | undefined {
  if (session.kind === 'canonical' || session.kind === 'legacy') return session.presented;
  return session.kind === 'conflicted' ? session.legacy : undefined;
}

function isDomainScoped(setCookie: string): boolean {
  return /;\s*Domain=/i.test(setCookie);
}

function setCookieName(setCookie: string): string {
  const pair = setCookie.split(';', 1)[0] ?? '';
  return pair.slice(0, pair.indexOf('=')).trim();
}

/**
 * The `Set-Cookie` values a successful login appends after NextAuth's own:
 * clears of the bridged name and the viewer marker in both scopes (and the
 * plain names the request carried), the host-only copy of the login name when
 * the login cookie is written with a Domain, then the login cookie, then the
 * viewer marker for `authSessionId` last, in the login cookie's scope. On a
 * host-only deployment the host-only clears of the login name and the marker
 * would delete the cookies just written, so they are left out there.
 */
export function loginSessionCookies(
  cookies: BrowserSessionCookieConfiguration,
  token: string,
  authSessionId: string,
  requestCookieNames: readonly string[],
): string[] {
  const writtenNames = new Set([
    browserSessionCookieName('login', cookies.secure),
    viewerMarkerCookieName(cookies.secure),
  ]);
  const writtenInDomainScope = cookies.domain !== undefined;
  const clears = browserSessionCookieClears({
    domain: cookies.domain,
    secure: cookies.secure,
    requestCookieNames,
  }).filter((clear) => !writtenNames.has(setCookieName(clear)) || isDomainScoped(clear) !== writtenInDomainScope);
  return [
    ...clears,
    serializeBrowserSessionCookie({
      kind: 'login',
      token,
      secret: cookies.secret,
      domain: cookies.domain,
      secure: cookies.secure,
    }),
    serializeViewerMarkerCookie({ authSessionId, domain: cookies.domain, secure: cookies.secure }),
  ];
}

/**
 * The `Set-Cookie` values a session read appends after bridging a legacy
 * cookie (B2b): the bridged cookie, after clears of the login name in both
 * scopes when the bridged login replaces a stale login cookie, then the viewer
 * marker for `authSessionId` in the bridged cookie's scope. When that scope is
 * the Domain, a host-only marker copy is cleared first, so the guard never
 * reads two differing copies after a cookie-scope change. The legacy cookie is
 * kept for the rollback window.
 */
export function bridgedSessionCookies(
  cookies: BrowserSessionCookieConfiguration,
  token: string,
  authSessionId: string,
  { replacesLoginCookie }: { replacesLoginCookie: boolean },
): string[] {
  const loginName = browserSessionCookieName('login', cookies.secure);
  const loginClears = replacesLoginCookie
    ? browserSessionCookieClears({
        domain: cookies.domain,
        secure: cookies.secure,
        requestCookieNames: [loginName],
      }).filter((clear) => setCookieName(clear) === loginName)
    : [];
  const markerName = viewerMarkerCookieName(cookies.secure);
  // Only the other scope: on a host-only deployment a host-only clear would delete the marker written below.
  const otherScopeMarkerClears =
    cookies.domain === undefined
      ? []
      : browserSessionCookieClears({ domain: cookies.domain, secure: cookies.secure, requestCookieNames: [] }).filter(
          (clear) => setCookieName(clear) === markerName && !isDomainScoped(clear),
        );
  return [
    ...loginClears,
    ...otherScopeMarkerClears,
    serializeBrowserSessionCookie({
      kind: 'bridged',
      token,
      secret: cookies.secret,
      domain: cookies.domain,
      secure: cookies.secure,
    }),
    serializeViewerMarkerCookie({ authSessionId, domain: cookies.domain, secure: cookies.secure }),
  ];
}

/** Sign-out: both first-party names and the viewer marker, both scopes, plus the plain names the request carried. */
export function signOutBrowserSessionCookieClears(
  cookies: BrowserSessionCookieConfiguration,
  requestCookieNames: readonly string[],
): string[] {
  return browserSessionCookieClears({ domain: cookies.domain, secure: cookies.secure, requestCookieNames });
}

const FIRST_PARTY_KINDS: readonly BrowserSessionCookieKind[] = ['login', 'bridged'];
// The viewer marker counts as a session cookie name: it is sent only beside one.
const SESSION_COOKIE_NAMES = new Set([
  ...FIRST_PARTY_KINDS.flatMap((kind) => [true, false].map((secure) => browserSessionCookieName(kind, secure))),
  ...[true, false].map((secure) => viewerMarkerCookieName(secure)),
  SECURE_SESSION_COOKIE_NAME,
  PLAIN_SESSION_COOKIE_NAME,
]);

function isSessionCookieName(name: string): boolean {
  if (SESSION_COOKIE_NAMES.has(name)) return true;
  // NextAuth's chunks: `<name>.0`, `<name>.1`, ...
  return [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME].some((legacy) => name.startsWith(`${legacy}.`));
}

/**
 * Removes every `Set-Cookie` for a session cookie name, legacy or first-party,
 * or the viewer marker, keeping the rest (CSRF, callback URL) in order. Session reads, csrf and
 * session updates under `better-auth` write and clear no session cookie.
 */
export function withoutSessionSetCookies(response: Response): Response {
  const kept = response.headers.getSetCookie().filter((header) => !isSessionCookieName(setCookieName(header)));
  response.headers.delete('Set-Cookie');
  for (const header of kept) response.headers.append('Set-Cookie', header);
  return response;
}

/**
 * `legacy` mode (review M2, owner option a): when a login or sign-out reply of
 * the legacy route writes or clears the legacy session cookie and the request
 * carried a first-party cookie of either name (any value, verified or not),
 * clear both first-party names and the viewer marker in both scopes too. Otherwise a first-party
 * cookie left from before a rollback would outrank this newer login or outlive
 * this sign-out once the mode is turned on again.
 *
 * It needs no secret and no `better-auth` precondition, and it never throws: a
 * cookie domain the codec refuses leaves the reply as it was. A request with no
 * first-party cookie (every request before the first cutover) gets the reply
 * byte for byte. Session reads and csrf are never touched.
 */
export function withLegacyModeFirstPartyClears(request: NextRequest, action: string, response: Response): Response {
  if (action === 'session' || action === 'csrf' || !carriesFirstPartyCookie(request)) return response;
  const writesLegacyCookie = response.headers
    .getSetCookie()
    .some((header) => isLegacyCookieName(setCookieName(header)));
  if (!writesLegacyCookie) return response;
  let clears: string[];
  try {
    clears = browserSessionCookieClears({
      domain: sessionCookieDomain(),
      secure: isSecureCookieContext(),
      requestCookieNames: request.cookies.getAll().map((requestCookie) => requestCookie.name),
    });
  } catch {
    return response;
  }
  for (const clear of clears) response.headers.append('Set-Cookie', clear);
  return response;
}

/** A device is recognized only after a real login cookie is published, never after a bridge or a clear. */
export function responseSetsBrowserLoginCookie(
  response: Response,
  configuration: BrowserSessionCookieConfiguration,
): boolean {
  const prefix = `${browserSessionCookieName('login', configuration.secure)}=`;
  return response.headers.getSetCookie().some((cookie) => {
    const pair = cookie.split(';', 1)[0] ?? '';
    return pair.startsWith(prefix) && pair.length > prefix.length && !/;\s*Max-Age=0(?:;|$)/i.test(cookie);
  });
}
