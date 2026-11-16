import 'server-only';
import { parseSetCookie } from 'cookie';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { BROWSER_PROOF_COOKIE_PREFIX } from './browser-proof-cookies.server';
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};

/** Budget the actual browser header after every returned cookie, including the
 * retained operation carrier. No synthetic omission of old A makes it fit. */
export function requireProviderCookieCapacity(observed: string | null, headers: Headers): void {
  if (Buffer.byteLength(observed ?? '') > 32_768) return refuse();
  const projected = new Map<string, string>();
  const uncertainWrites: string[] = [];
  for (const piece of (observed ?? '').split(';').filter((part) => part.trim())) {
    const pair = piece.trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) return refuse();
    const name = pair.slice(0, separator);
    if (projected.has(name)) return refuse();
    projected.set(name, pair.slice(separator + 1));
  }
  for (const header of headers.getSetCookie()) {
    const cookie = parseSetCookie(header);
    if (!cookie.name || cookie.value === undefined) return refuse();
    // Only these code-owned Host cookies have a known root/host scope. A
    // framework or partner clear at another path/domain cannot subtract an
    // observed pair; the Cookie header does not describe its stored scope.
    const replacesObserved =
      (cookie.name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) ||
        cookie.name.startsWith('__Host-boardsesh.provider-signin.')) &&
      cookie.path === '/' &&
      cookie.secure === true &&
      cookie.httpOnly === true &&
      !cookie.domain &&
      !cookie.partitioned;
    if (
      (cookie.maxAge !== undefined && cookie.maxAge <= 0) ||
      (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now())
    ) {
      if (replacesObserved) projected.delete(cookie.name);
    } else if (projected.has(cookie.name) && !replacesObserved) {
      uncertainWrites.push(`${cookie.name}=${cookie.value}`);
    } else projected.set(cookie.name, cookie.value);
  }
  if (
    projected.size + uncertainWrites.length > 128 ||
    Buffer.byteLength(
      [...projected]
        .map(([name, content]) => `${name}=${content}`)
        .concat(uncertainWrites)
        .join('; '),
    ) > 8192
  )
    return refuse();
}
