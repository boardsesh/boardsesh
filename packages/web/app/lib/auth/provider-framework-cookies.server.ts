import 'server-only';
import { parseSetCookie } from 'cookie';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { BROWSER_CORRELATION_COOKIE, BROWSER_PROOF_COOKIE_PREFIX } from './browser-proof-cookies.server';
import { providerSecuritySessionFamily } from './provider-security-publication.server';

export const providerCookieFamily = (name: string, base: string): boolean =>
  name === base || name.startsWith(`${base}.`);
export function providerFrameworkProtectedCookie(name: string): boolean {
  return (
    providerSecuritySessionFamily(name) ||
    name.startsWith(BROWSER_CORRELATION_COOKIE) ||
    name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) ||
    name.startsWith('__Host-boardsesh.')
  );
}
export function providerFrameworkCandidate(headers: readonly string[], name: string): string {
  const refuse = (): never => {
    throw new AuthBackendUnavailableError();
  };
  const fresh = headers
    .map((header) => parseSetCookie(header))
    .filter((cookie) => cookie.value && (cookie.maxAge === undefined || cookie.maxAge > 0));
  if (
    !fresh.length ||
    fresh.some((cookie) => !providerCookieFamily(cookie.name, name)) ||
    new Set(fresh.map((cookie) => cookie.name)).size !== fresh.length
  )
    return refuse();
  if (fresh.some((cookie) => cookie.name === name)) {
    if (fresh.length !== 1) return refuse();
  } else {
    fresh.sort((left, right) => Number(left.name.slice(name.length + 1)) - Number(right.name.slice(name.length + 1)));
    if (fresh.some((cookie, index) => cookie.name !== `${name}.${index}`)) return refuse();
  }
  return fresh.map((cookie) => cookie.value).join('');
}
