import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { normalizeIpAddress } from '@boardsesh/consent/edge-country';
import { isPrivatePeerAddress, resolveEdgeVisitorIp } from './flag-country';

/**
 * Stable client identity behind Cloudflare and Railway.
 *
 * Cloudflare's authenticated edge header wins. Otherwise Railway appends the
 * peer it observed to x-forwarded-for, so the last hop is the non-spoofable one.
 * Callers should pair this with a socket-peer ceiling because a direct client
 * can supply cf-connecting-ip before the request reaches Railway.
 */
export function getPublicClientIp(req: IncomingMessage): string {
  const cloudflareClientIp = req.headers['cf-connecting-ip'];
  const cloudflareIp = Array.isArray(cloudflareClientIp) ? cloudflareClientIp[0] : cloudflareClientIp;
  if (cloudflareIp?.trim()) return cloudflareIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  const forwardedChain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const lastHop = forwardedChain?.split(',').at(-1)?.trim();
  return lastHop || req.socket.remoteAddress || 'unknown';
}

/** The eight 16-bit groups of a valid IPv6 address, however it was spelled. */
function ipv6Groups(address: string): number[] {
  let text = address.split('%')[0];
  const finalGroup = text.slice(text.lastIndexOf(':') + 1);
  if (finalGroup.includes('.')) {
    const [first, second, third, fourth] = finalGroup.split('.').map(Number);
    const highGroup = ((first << 8) | second).toString(16);
    const lowGroup = ((third << 8) | fourth).toString(16);
    text = `${text.slice(0, text.lastIndexOf(':') + 1)}${highGroup}:${lowGroup}`;
  }
  const [head, tail] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const zeroGroups = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill('0');
  return [...headGroups, ...zeroGroups, ...tailGroups].map((group) => Number.parseInt(group, 16));
}

/**
 * The identity a per-address limit counts. One host is routinely given a whole
 * /64, so a full IPv6 address would give it 2^64 buckets. An IPv4-mapped address
 * is that IPv4 address, in either spelling.
 */
function limitIdentity(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * The client identity for a limit a stranger must not be able to choose. Unlike
 * `getPublicClientIp`, this believes `cf-connecting-ip` only from a verified
 * Cloudflare edge (docs/cloudflare.md), because a direct request to the origin
 * can set that header to anything. Otherwise it is the last `X-Forwarded-For`
 * hop, which the private ingress appends, and never an earlier one a caller wrote.
 *
 * Returns a limit key, not an address to contact: an IPv6 client is its /64.
 */
export function getTrustedClientIp(req: IncomingMessage): string {
  const edgeVisitor = resolveEdgeVisitorIp(req);
  if (edgeVisitor) return limitIdentity(edgeVisitor);
  const socketPeer = normalizeIpAddress(req.socket.remoteAddress);
  const forwardedFor = req.headers['x-forwarded-for'];
  if (socketPeer && isPrivatePeerAddress(socketPeer) && typeof forwardedFor === 'string') {
    const appendedHop = normalizeIpAddress(forwardedFor.split(',').at(-1));
    if (appendedHop) return limitIdentity(appendedHop);
  }
  return socketPeer ? limitIdentity(socketPeer) : 'unknown';
}
