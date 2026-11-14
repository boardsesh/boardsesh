import { createHash } from 'node:crypto';
import type { BrowserBindingCursor } from './browser-binding';

export const BROWSER_BINDING_COOKIE = '__Secure-boardsesh.browser-binding';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Fixed binding cookie, never a mutable current-login pointer. No public
 * handler calls this while the canonical bootstrap/coordinator gate is open. */
export function serializeBrowserBindingCookie(
  token: string,
  cursor: BrowserBindingCursor,
  origin: string,
  domain?: string,
): string {
  const address = new URL(origin);
  if (
    !tokenPattern.test(token) ||
    createHash('sha256').update(token).digest('hex') !== cursor.bindingId ||
    address.protocol !== 'https:' ||
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash ||
    !Number.isFinite(cursor.bindingExpiresAt.getTime()) ||
    (domain !== undefined &&
      (!/^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(domain) ||
        !(address.hostname === domain.slice(1) || address.hostname.endsWith(domain))))
  )
    throw new Error('BROWSER_BINDING_COOKIE_SCOPE_INVALID');
  return `${BROWSER_BINDING_COOKIE}=${token}; Path=/; Expires=${cursor.bindingExpiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax${domain ? `; Domain=${domain}` : ''}`;
}

export function presentedBrowserBinding(
  cookieHeader: string | null,
):
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'present'; readonly token: string } {
  const entries = (cookieHeader ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.split('=')[0].startsWith(BROWSER_BINDING_COOKIE));
  if (!entries.length) return { status: 'missing' };
  if (entries.length !== 1 || !entries[0].startsWith(`${BROWSER_BINDING_COOKIE}=`)) return { status: 'invalid' };
  const token = entries[0].slice(BROWSER_BINDING_COOKIE.length + 1);
  return tokenPattern.test(token) ? { status: 'present', token } : { status: 'invalid' };
}
