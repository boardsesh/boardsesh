import 'server-only';
import { isIPv6 } from 'node:net';
import { isCloudflareEdgeAddress, normalizeIpAddress } from '@boardsesh/consent/edge-country';
import { webPasswordMode } from './password-command-client.server';

/** A customer holds a whole `/64`, so an address inside it must not buy a fresh bucket. */
function ipv6Subnet(address: string): string {
  const [leading = '', trailing] = address.split('::');
  const leadingGroups = leading ? leading.split(':') : [];
  const trailingGroups = trailing ? trailing.split(':') : [];
  const elidedGroups = Array<string>(Math.max(0, 8 - leadingGroups.length - trailingGroups.length)).fill('0');
  const networkGroups = [...leadingGroups, ...elidedGroups, ...trailingGroups].slice(0, 4);
  return `${networkGroups.map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

/**
 * Rate-limit key a caller cannot choose. See docs/cloudflare.md.
 *
 * A route handler cannot see its socket peer. Our ingress appends the peer it
 * observed to `X-Forwarded-For`, so only the LAST hop is out of the caller's
 * reach. When that hop is a Cloudflare edge, the visitor is `CF-Connecting-IP`.
 * Otherwise the request went straight to the origin and the last hop is the
 * caller itself, whatever `CF-Connecting-IP` it sent.
 */
export function trustedClientRateLimitKey(request: Request): string {
  const lastHop = normalizeIpAddress(request.headers.get('x-forwarded-for')?.split(',').at(-1));
  if (!lastHop) return 'unknown';
  const clientAddress = isCloudflareEdgeAddress(lastHop)
    ? (normalizeIpAddress(request.headers.get('cf-connecting-ip') ?? undefined) ?? lastHop)
    : lastHop;
  return isIPv6(clientAddress) ? ipv6Subnet(clientAddress) : clientAddress;
}

/** Null unless staged email auth is on, so legacy routes keep their existing limiter input. */
export function stagedPasswordClientKey(request: Request): string | null {
  try {
    return webPasswordMode() === 'backend-staging' ? trustedClientRateLimitKey(request) : null;
  } catch {
    return null;
  }
}
