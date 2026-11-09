import 'server-only';
import { isIPv6 } from 'node:net';
import { isCloudflareEdgeAddress, normalizeIpAddress } from '@boardsesh/consent/edge-country';
import { webPasswordMode } from './password-command-client.server';

/** One bucket for edge requests with no usable visitor, whichever edge address carried them. */
const EDGE_WITHOUT_VISITOR_KEY = 'edge-without-visitor';

function dottedTailToHex(address: string): string {
  const tailStart = address.lastIndexOf(':') + 1;
  const tail = address.slice(tailStart);
  if (!tail.includes('.')) return address;
  const [first, second, third, fourth] = tail.split('.').map(Number);
  return `${address.slice(0, tailStart)}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
}

/** The eight groups of a valid IPv6 address, with `::` filled in. */
function ipv6Groups(address: string): number[] {
  const [leading = '', trailing] = dottedTailToHex(address).split('::');
  const leadingGroups = leading ? leading.split(':') : [];
  const trailingGroups = trailing ? trailing.split(':') : [];
  const elidedGroups = Array<string>(Math.max(0, 8 - leadingGroups.length - trailingGroups.length)).fill('0');
  return [...leadingGroups, ...elidedGroups, ...trailingGroups].map((group) => Number.parseInt(group, 16));
}

function clientBucket(address: string): string {
  if (!isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  // Every spelling of an IPv4-mapped address is the same IPv4 client.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  // A customer holds a whole `/64`, so an address inside it must not buy a fresh bucket.
  const networkGroups = groups.slice(0, 4).map((group) => group.toString(16));
  return `${networkGroups.join(':')}::/64`;
}

/**
 * Rate-limit key a caller cannot choose. See docs/cloudflare.md and the staged
 * requirements in docs/better-auth-web-password-delegation.md.
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
  if (!isCloudflareEdgeAddress(lastHop)) return clientBucket(lastHop);
  const visitor = normalizeIpAddress(request.headers.get('cf-connecting-ip') ?? undefined);
  return visitor ? clientBucket(visitor) : EDGE_WITHOUT_VISITOR_KEY;
}

/** Null unless staged email auth is on, so legacy routes keep their existing limiter input. */
export function stagedPasswordClientKey(request: Request): string | null {
  try {
    return webPasswordMode() === 'backend-staging' ? trustedClientRateLimitKey(request) : null;
  } catch {
    return null;
  }
}
