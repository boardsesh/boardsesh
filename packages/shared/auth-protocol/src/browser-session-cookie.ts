/// <reference types="node" />

/**
 * The first-party browser session cookie for the Better Auth cutover on www and
 * app.boardsesh.com (#7596, B1). Pure codec: names, signature, attributes and
 * clears. Nothing here reads the environment or a request; the caller passes
 * the secret, the secure-context flag and the cookie domain.
 *
 * Server only. It uses `node:crypto`, so it runs in the Next server (Node
 * runtime) and the backend, never in an Edge runtime, a browser bundle or the
 * native app. Import it through `@boardsesh/auth-protocol/browser-session-cookie`
 * only; the package root must never re-export it, and a boundary test holds
 * native code away from it.
 *
 * Scope rules match `packages/web/app/lib/auth/secure-cookies.ts`: the
 * `__Secure-` prefix in a secure context and no prefix on local http, the
 * shared `.boardsesh.com` Domain only where the caller says so (production
 * www/apex), host-only on previews and local. A Domain cookie is never written
 * or cleared without `Secure`.
 *
 * Value: `<token>.<base64url HMAC-SHA256(secret, "<kind>:<token>")>`. The kind
 * is in the signed input, so a login value does not verify under the bridged
 * name, nor the reverse.
 *
 * The viewer marker (`viewer-marker.ts`) rides with it: written beside a
 * session cookie by the same response and cleared by every clear here, so one
 * is never sent without the other. Nothing on the server reads it.
 *
 * What a caller must do (the codec cannot check these):
 * - `secure` is never false in production. Fail startup if production resolves
 *   to it; plain names can be set from http or `document.cookie` on any
 *   subdomain.
 * - Validate the secret once at startup, not per request. Every function here
 *   throws `BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT` for a short or non-string
 *   secret, so an unchecked bad env would fail every request that reads a
 *   session. Use a different secret on previews and local, and use it for
 *   nothing else.
 * - Never take authority from the cookie name. Whether a session is bridged
 *   (and so never fresh) comes from the session row.
 * - Run on the Node runtime only. `packages/web/middleware.ts` runs on Edge and
 *   cannot import this.
 * - Pass the `Cookie` header as received (`headers.get('cookie')`). A header
 *   rebuilt or joined with `, ` is not parsed.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { VIEWER_MARKER_VALUE_LENGTH, viewerMarkerCookieName, viewerMarkerDigestInput } from './viewer-marker';

/**
 * Cookie names, one block. The two-name split is a recommendation pending the
 * owner; changing a name is a one-line change here.
 *
 * `login` is written by a login response. `bridged` is written when a legacy
 * NextAuth cookie is bridged to a new session (B2). A login cookie always
 * outranks a bridged one.
 */
const BROWSER_SESSION_COOKIE_BASE_NAMES = {
  login: 'boardsesh.session_token',
  bridged: 'boardsesh.bridged_session_token',
} as const;
const SECURE_COOKIE_PREFIX = '__Secure-';

export type BrowserSessionCookieKind = keyof typeof BROWSER_SESSION_COOKIE_BASE_NAMES;

const BROWSER_SESSION_COOKIE_KINDS: readonly BrowserSessionCookieKind[] = ['login', 'bridged'];

/** 400 days, Chrome's cap. The session row's own 30-day rolling expiry is what ends a session (owner decision 2). */
export const BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS = 34_560_000;

/** HMAC-SHA256 key floor, in UTF-8 bytes. */
export const BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES = 32;

/** Base64url without padding and no `.`, so `<token>.<signature>` splits one way only. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
/** An unpadded base64url SHA-256 digest is exactly 43 characters. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A plain host name, optionally with a leading dot. Anything else could inject attributes. */
const DOMAIN_PATTERN =
  /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const MAX_DOMAIN_LENGTH = 253;

export function browserSessionCookieName(kind: BrowserSessionCookieKind, secure: boolean): string {
  const baseName = BROWSER_SESSION_COOKIE_BASE_NAMES[kind];
  return secure ? `${SECURE_COOKIE_PREFIX}${baseName}` : baseName;
}

function assertSecret(secret: string): void {
  // The typeof guard keeps an unset env from surfacing as a bare TypeError.
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES) {
    throw new Error('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
  }
}

/** A shared-domain cookie without `Secure` could be set or replaced from plain http, so neither is ever emitted. */
function assertDomain(domain: string | undefined, secure: boolean): void {
  if (domain === undefined) return;
  if (domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    throw new Error('BROWSER_SESSION_COOKIE_DOMAIN_INVALID');
  }
  if (!secure) throw new Error('BROWSER_SESSION_COOKIE_DOMAIN_REQUIRES_SECURE');
}

function signatureOf(kind: BrowserSessionCookieKind, token: string, secret: string): string {
  return createHmac('sha256', secret).update(`${kind}:${token}`).digest('base64url');
}

/**
 * `<token>.<base64url HMAC-SHA256(secret, "<kind>:<token>")>`. Throws on a short
 * or non-string secret, or a token outside base64url.
 */
export function signBrowserSessionCookie(kind: BrowserSessionCookieKind, token: string, secret: string): string {
  assertSecret(secret);
  if (!TOKEN_PATTERN.test(token)) throw new Error('BROWSER_SESSION_COOKIE_TOKEN_INVALID');
  return `${token}.${signatureOf(kind, token, secret)}`;
}

/** The raw token when the value is well formed and its signature verifies, in constant time; otherwise undefined. */
function verifiedToken(kind: BrowserSessionCookieKind, cookieValue: string, secret: string): string | undefined {
  const separatorIndex = cookieValue.indexOf('.');
  if (separatorIndex === -1) return undefined;
  const token = cookieValue.slice(0, separatorIndex);
  const presentedSignature = cookieValue.slice(separatorIndex + 1);
  if (!TOKEN_PATTERN.test(token) || !SIGNATURE_PATTERN.test(presentedSignature)) return undefined;
  // Comparing the canonical encodings (both 43 ASCII bytes) rejects the
  // non-canonical spellings a lenient base64 decoder would accept.
  const expected = Buffer.from(signatureOf(kind, token, secret), 'utf8');
  const presented = Buffer.from(presentedSignature, 'utf8');
  return timingSafeEqual(expected, presented) ? token : undefined;
}

/**
 * Strips only space and tab, as a browser does. `String.prototype.trim` also
 * strips VT, FF, CR, LF, NBSP and U+FEFF; a name carrying one of those is a
 * different cookie to the browser, one that need not have been set with Secure.
 */
const COOKIE_WHITESPACE = /^[ \t]+|[ \t]+$/g;

function stripCookieWhitespace(text: string): string {
  return text.replace(COOKIE_WHITESPACE, '');
}

/** Every value sent under each wanted name, in header order. Names compare exactly. */
function valuesByName(cookieHeader: string, wantedNames: ReadonlySet<string>): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = stripCookieWhitespace(pair.slice(0, separatorIndex));
    if (!wantedNames.has(name)) continue;
    const cookieValue = stripCookieWhitespace(pair.slice(separatorIndex + 1));
    const existing = values.get(name);
    if (existing) existing.push(cookieValue);
    else values.set(name, [cookieValue]);
  }
  return values;
}

export interface BrowserSessionCookies {
  login?: string;
  bridged?: string;
  /** Kinds whose name arrived more than once with differing values. Never also set above. */
  conflicted: BrowserSessionCookieKind[];
}

/**
 * Verified raw tokens from a `Cookie` header, for the names of the caller's
 * context only (`__Secure-` names when `secure`, plain names otherwise).
 *
 * A missing, malformed or tampered value is absent; this never throws for a
 * value. It throws only for a short or non-string secret, which is a
 * configuration error, and it checks the secret even for an empty header.
 *
 * Duplicate names: a browser can hold two cookies of one name, one Domain-scoped
 * and one host-only, and sends both. Their order in the header is not reliable
 * across those scopes (docs/auth/better-auth-browser-cookie-order.md), so "first
 * wins" would let the wrong copy win. When every copy carries the same value,
 * that value is used. When the copies differ in any way (two sessions, or one
 * valid and one tampered or empty), that kind has no token and is listed in
 * `conflicted`. Each name is ruled on separately.
 *
 * Both tokens are returned when both verify. A login cookie always outranks a
 * bridged one. A conflicted login means the browser is signed out: the caller
 * must not fall through to the bridged cookie, because a conflict would then
 * demote or swap the session.
 */
export function readBrowserSessionCookies(
  cookieHeader: string | null | undefined,
  secret: string,
  secure: boolean,
): BrowserSessionCookies {
  assertSecret(secret);
  const result: BrowserSessionCookies = { conflicted: [] };
  if (!cookieHeader) return result;
  const namesByKind = new Map(
    BROWSER_SESSION_COOKIE_KINDS.map((kind) => [kind, browserSessionCookieName(kind, secure)]),
  );
  const values = valuesByName(cookieHeader, new Set(namesByKind.values()));
  for (const [kind, name] of namesByKind) {
    const sentValues = values.get(name);
    if (!sentValues) continue;
    const [firstValue] = sentValues;
    if (firstValue === undefined) continue;
    if (sentValues.some((sentValue) => sentValue !== firstValue)) {
      result.conflicted.push(kind);
      continue;
    }
    const token = verifiedToken(kind, firstValue, secret);
    if (token !== undefined) result[kind] = token;
  }
  return result;
}

export interface BrowserSessionCookieOptions {
  kind: BrowserSessionCookieKind;
  token: string;
  secret: string;
  /** `.boardsesh.com` in production; omit for a host-only cookie on previews and local. Requires `secure`. */
  domain?: string;
  /** Secure context: `__Secure-` name plus the `Secure` attribute. False only on local http, never in production. */
  secure: boolean;
}

/** One `Set-Cookie` value that installs a signed session cookie. */
export function serializeBrowserSessionCookie({
  kind,
  token,
  secret,
  domain,
  secure,
}: BrowserSessionCookieOptions): string {
  assertDomain(domain, secure);
  const signedValue = signBrowserSessionCookie(kind, token, secret);
  const name = browserSessionCookieName(kind, secure);
  return `${name}=${signedValue}; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=${BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearCookie(name: string, domain: string | undefined, secure: boolean, httpOnly = true): string {
  return `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0${httpOnly ? '; HttpOnly' : ''}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * The viewer marker (`viewer-marker.ts`) for a login: the first 16 characters
 * of `base64url(sha256("boardsesh-viewer-v1:" + authSessionId))`. The same
 * value `computeViewerMarker` gives in a browser. Throws for an empty id.
 */
export function viewerMarkerValue(authSessionId: string): string {
  if (typeof authSessionId !== 'string' || authSessionId.length === 0)
    throw new Error('VIEWER_MARKER_SESSION_ID_INVALID');
  return createHash('sha256')
    .update(viewerMarkerDigestInput(authSessionId))
    .digest('base64url')
    .slice(0, VIEWER_MARKER_VALUE_LENGTH);
}

export interface ViewerMarkerCookieOptions {
  /** The login the session cookie in the same response names. */
  authSessionId: string;
  /** Exactly the session cookie's own `domain`, so both cookies share a scope. Requires `secure`. */
  domain?: string;
  /** The session cookie's own secure-context flag. */
  secure: boolean;
}

/**
 * One `Set-Cookie` value that installs the viewer marker beside a session
 * cookie: the session cookie's Path, Domain, Max-Age, SameSite and Secure, and
 * not HttpOnly, so page scripts can compare it. Only the session-cookie
 * builders call this, so the marker is never sent without the cookie it names.
 */
export function serializeViewerMarkerCookie({ authSessionId, domain, secure }: ViewerMarkerCookieOptions): string {
  assertDomain(domain, secure);
  const name = viewerMarkerCookieName(secure);
  return `${name}=${viewerMarkerValue(authSessionId)}; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=${BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export interface BrowserSessionCookieClearOptions {
  /** The same domain the cookies are written with; omit on previews and local. Requires `secure`. */
  domain?: string;
  /** The same secure-context flag the cookies are written with. */
  secure: boolean;
  /** Every cookie name the request carried, as received. */
  requestCookieNames: readonly string[];
}

/**
 * `Set-Cookie` values that delete both session cookies at `Path=/` in the
 * host-only scope and, when `domain` is given, the Domain scope too, then the
 * viewer marker in the same scopes by the same name rule (its clears carry no
 * HttpOnly, as it is written without).
 *
 * The two `__Secure-` names are always cleared; a `__Secure-` cookie is only
 * accepted with `Secure`, so its deletion carries it (over http the browser
 * drops that line, and no such cookie can exist there). A plain name is cleared
 * only when the request carried it, with `Secure` when `secure` and without it
 * on local http so the deletion is accepted there.
 *
 * Only `Path=/` is reached. A cookie set with any other `Path` (only an
 * attacker would set one) cannot be cleared without knowing that path, and a
 * plain cookie at another path may exist even though this request did not
 * carry it. The clears end the cookies this module writes; they are not a
 * sign-out on their own, which also revokes the session server side.
 */
export function browserSessionCookieClears({
  domain,
  secure,
  requestCookieNames,
}: BrowserSessionCookieClearOptions): string[] {
  assertDomain(domain, secure);
  const carriedNames = new Set(requestCookieNames);
  const clears: string[] = [];
  const appendClears = (name: string, secureClear: boolean) => {
    clears.push(clearCookie(name, undefined, secureClear));
    if (domain) clears.push(clearCookie(name, domain, secureClear));
  };
  for (const kind of BROWSER_SESSION_COOKIE_KINDS) appendClears(browserSessionCookieName(kind, true), true);
  for (const kind of BROWSER_SESSION_COOKIE_KINDS) {
    const plainName = browserSessionCookieName(kind, false);
    if (carriedNames.has(plainName)) appendClears(plainName, secure);
  }
  const appendMarkerClears = (name: string, secureClear: boolean) => {
    clears.push(clearCookie(name, undefined, secureClear, false));
    if (domain) clears.push(clearCookie(name, domain, secureClear, false));
  };
  appendMarkerClears(viewerMarkerCookieName(true), true);
  const plainMarker = viewerMarkerCookieName(false);
  if (carriedNames.has(plainMarker)) appendMarkerClears(plainMarker, secure);
  return clears;
}
