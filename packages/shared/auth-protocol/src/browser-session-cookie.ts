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
 * www/apex), host-only on previews and local.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

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
  if (Buffer.byteLength(secret, 'utf8') < BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES) {
    throw new Error('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
  }
}

function assertDomain(domain: string | undefined): void {
  if (domain === undefined) return;
  if (domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    throw new Error('BROWSER_SESSION_COOKIE_DOMAIN_INVALID');
  }
}

function signatureOf(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

/** `<token>.<base64url HMAC-SHA256(secret, token)>`. Throws on a short secret or a token outside base64url. */
export function signBrowserSessionCookie(token: string, secret: string): string {
  assertSecret(secret);
  if (!TOKEN_PATTERN.test(token)) throw new Error('BROWSER_SESSION_COOKIE_TOKEN_INVALID');
  return `${token}.${signatureOf(token, secret)}`;
}

/** The raw token when the value is well formed and its signature verifies, in constant time; otherwise undefined. */
function verifiedToken(cookieValue: string, secret: string): string | undefined {
  const separatorIndex = cookieValue.indexOf('.');
  if (separatorIndex === -1) return undefined;
  const token = cookieValue.slice(0, separatorIndex);
  const presentedSignature = cookieValue.slice(separatorIndex + 1);
  if (!TOKEN_PATTERN.test(token) || !SIGNATURE_PATTERN.test(presentedSignature)) return undefined;
  // Comparing the canonical encodings (both 43 ASCII bytes) rejects the
  // non-canonical spellings a lenient base64 decoder would accept.
  const expected = Buffer.from(signatureOf(token, secret), 'utf8');
  const presented = Buffer.from(presentedSignature, 'utf8');
  return timingSafeEqual(expected, presented) ? token : undefined;
}

/** Every value sent under each wanted name, in header order. Names compare exactly. */
function valuesByName(cookieHeader: string, wantedNames: ReadonlySet<string>): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = pair.slice(0, separatorIndex).trim();
    if (!wantedNames.has(name)) continue;
    const cookieValue = pair.slice(separatorIndex + 1).trim();
    const existing = values.get(name);
    if (existing) existing.push(cookieValue);
    else values.set(name, [cookieValue]);
  }
  return values;
}

export interface BrowserSessionCookies {
  login?: string;
  bridged?: string;
}

/**
 * Verified raw tokens from a `Cookie` header, for the names of the caller's
 * context only (`__Secure-` names when `secure`, plain names otherwise).
 *
 * A missing, malformed or tampered value is absent; this never throws for a
 * value. It throws only for a short secret, which is a configuration error.
 *
 * Duplicate names: a browser can hold two cookies of one name, one Domain-scoped
 * and one host-only, and sends both. Their order in the header is not reliable
 * across those scopes (docs/better-auth-browser-cookie-order.md), so "first
 * wins" would let the wrong copy win. When every copy carries the same value,
 * that value is used. When the copies differ in any way (two sessions, or one
 * valid and one tampered or empty), that name is absent and the caller treats
 * the browser as not signed in under it. Each name is ruled on separately.
 *
 * Both tokens are returned when both verify. A login cookie always outranks a
 * bridged one; choosing between them is the caller's job.
 */
export function readBrowserSessionCookies(
  cookieHeader: string | null | undefined,
  secret: string,
  secure: boolean,
): BrowserSessionCookies {
  assertSecret(secret);
  const result: BrowserSessionCookies = {};
  if (!cookieHeader) return result;
  const namesByKind = new Map(
    BROWSER_SESSION_COOKIE_KINDS.map((kind) => [kind, browserSessionCookieName(kind, secure)]),
  );
  const values = valuesByName(cookieHeader, new Set(namesByKind.values()));
  for (const [kind, name] of namesByKind) {
    const sentValues = values.get(name);
    if (!sentValues) continue;
    const [firstValue] = sentValues;
    if (firstValue === undefined || sentValues.some((sentValue) => sentValue !== firstValue)) continue;
    const token = verifiedToken(firstValue, secret);
    if (token !== undefined) result[kind] = token;
  }
  return result;
}

export interface BrowserSessionCookieOptions {
  kind: BrowserSessionCookieKind;
  token: string;
  secret: string;
  /** `.boardsesh.com` in production; omit for a host-only cookie on previews and local. */
  domain?: string;
  /** Secure context: `__Secure-` name plus the `Secure` attribute. False only on local http. */
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
  assertDomain(domain);
  const signedValue = signBrowserSessionCookie(token, secret);
  const name = browserSessionCookieName(kind, secure);
  return `${name}=${signedValue}; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=${BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearCookie(name: string, domain: string | undefined, secure: boolean): string {
  return `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * `Set-Cookie` values that delete both session cookies in the host-only scope
 * and, when `domain` is given, the Domain scope too.
 *
 * The two `__Secure-` names are always cleared; a `__Secure-` cookie is only
 * accepted with `Secure`, so its deletion carries it (over http the browser
 * drops that line, and no such cookie can exist there). A plain name is cleared
 * only when the request carried it, without `Secure` so local http accepts the
 * deletion. A plain cookie the request did not carry does not exist for this
 * host, because both scopes would have sent it.
 */
export function browserSessionCookieClears(
  domain: string | undefined,
  requestCookieNames: readonly string[],
): string[] {
  assertDomain(domain);
  const carriedNames = new Set(requestCookieNames);
  const clears: string[] = [];
  const appendClears = (name: string, secure: boolean) => {
    clears.push(clearCookie(name, undefined, secure));
    if (domain) clears.push(clearCookie(name, domain, secure));
  };
  for (const kind of BROWSER_SESSION_COOKIE_KINDS) appendClears(browserSessionCookieName(kind, true), true);
  for (const kind of BROWSER_SESSION_COOKIE_KINDS) {
    const plainName = browserSessionCookieName(kind, false);
    if (carriedNames.has(plainName)) appendClears(plainName, false);
  }
  return clears;
}
