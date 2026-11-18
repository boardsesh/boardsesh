import 'server-only';
import type { NextRequest } from 'next/server';
import { LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH, type PresentedWebSession } from '@boardsesh/auth-protocol';
import {
  browserSessionCookieClears,
  browserSessionCookieName,
  readBrowserSessionCookies,
  serializeBrowserSessionCookie,
  type BrowserSessionCookieKind,
} from '@boardsesh/auth-protocol/browser-session-cookie';
import { webLogger } from '@/app/lib/observability/logger';
import { capturePresentedWebCredential } from './admitted-session.server';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { PLAIN_SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME } from './secure-cookies';

/**
 * The session a request arrived with, under `AUTH_BROWSER_SESSION_MODE=better-auth`.
 *
 * - `canonical`: a verified first-party cookie. The login cookie outranks the
 *   bridged one. Which one it was says nothing about the session (freshness and
 *   source come from the backend's session row), so it is not carried on.
 * - `conflicted`: the login cookie arrived as differing copies. The browser is
 *   signed out; neither the bridged nor the legacy cookie stands in for it.
 * - `legacy`: no first-party cookie, and a NextAuth cookie no longer than the
 *   command accepts. An oversized one is dropped here, before any command.
 * - `none`.
 */
export type RequestBrowserSession =
  | { kind: 'canonical'; presented: Extract<PresentedWebSession, { kind: 'canonical-token' }> }
  | { kind: 'conflicted' }
  | { kind: 'legacy'; presented: Extract<PresentedWebSession, { kind: 'legacy-jwe' }> }
  | { kind: 'none' };

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
  if (read.conflicted.includes('login')) {
    webLogger.warn('browser session cookie conflicted', { kinds: read.conflicted.join(',') });
    return { kind: 'conflicted' };
  }
  const token = read.login ?? read.bridged;
  if (token !== undefined) return { kind: 'canonical', presented: { kind: 'canonical-token', token } };
  const legacy = await capturePresentedWebCredential(request);
  if (!legacy || legacy.credential.length > LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH) return { kind: 'none' };
  return { kind: 'legacy', presented: { kind: 'legacy-jwe', credential: legacy.credential } };
}

/** What a login presents for revocation, or undefined for nothing. */
export function presentedForLogin(session: RequestBrowserSession): PresentedWebSession | undefined {
  return session.kind === 'canonical' || session.kind === 'legacy' ? session.presented : undefined;
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
 * clears of the bridged name in both scopes (and the plain names the request
 * carried), the host-only copy of the login name when the login cookie is
 * written with a Domain, then the login cookie last. On a host-only
 * deployment the host-only login clear would delete the cookie just written,
 * so it is left out there.
 */
export function loginSessionCookies(
  cookies: BrowserSessionCookieConfiguration,
  token: string,
  requestCookieNames: readonly string[],
): string[] {
  const loginName = browserSessionCookieName('login', cookies.secure);
  const writtenInDomainScope = cookies.domain !== undefined;
  const clears = browserSessionCookieClears({
    domain: cookies.domain,
    secure: cookies.secure,
    requestCookieNames,
  }).filter((clear) => setCookieName(clear) !== loginName || isDomainScoped(clear) !== writtenInDomainScope);
  return [
    ...clears,
    serializeBrowserSessionCookie({
      kind: 'login',
      token,
      secret: cookies.secret,
      domain: cookies.domain,
      secure: cookies.secure,
    }),
  ];
}

/** Sign-out: both first-party names, both scopes, plus the plain names the request carried. */
export function signOutBrowserSessionCookieClears(
  cookies: BrowserSessionCookieConfiguration,
  requestCookieNames: readonly string[],
): string[] {
  return browserSessionCookieClears({ domain: cookies.domain, secure: cookies.secure, requestCookieNames });
}

const FIRST_PARTY_KINDS: readonly BrowserSessionCookieKind[] = ['login', 'bridged'];
const SESSION_COOKIE_NAMES = new Set([
  ...FIRST_PARTY_KINDS.flatMap((kind) => [true, false].map((secure) => browserSessionCookieName(kind, secure))),
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
 * keeping the rest (CSRF, callback URL) in order. Session reads, csrf and
 * session updates under `better-auth` write and clear no session cookie.
 */
export function withoutSessionSetCookies(response: Response): Response {
  const kept = response.headers.getSetCookie().filter((header) => !isSessionCookieName(setCookieName(header)));
  response.headers.delete('Set-Cookie');
  for (const header of kept) response.headers.append('Set-Cookie', header);
  return response;
}
