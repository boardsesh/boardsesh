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
  return ipv6PrefixKey(groups, 4);
}

/** `a:b:c:d::/64` for four groups, `a:b:c::/48` for three. */
function ipv6PrefixKey(groups: number[], prefixGroups: number): string {
  return `${groups
    .slice(0, prefixGroups)
    .map((group) => group.toString(16))
    .join(':')}::/${prefixGroups * 16}`;
}

const IPV6_LIMIT_SUFFIX = '::/64';

/**
 * The group a limit identity shares the `/v1` admission lane with
 * (`auth/partner/admission.ts`): an IPv6 /64 becomes its /48, and anything else,
 * an IPv4 address or a key that is not an address, is its own group. A /48 is
 * what one site is routinely given, so a sender rotating through fresh /64s
 * inside it still counts as one. The price is that every phone behind one
 * carrier /48, like every phone behind one carrier-NAT IPv4 address, shares one
 * group's places in the shared lane.
 */
export function apiLaneGroup(limitKey: string): string {
  if (!limitKey.endsWith(IPV6_LIMIT_SUFFIX)) return limitKey;
  const network = `${limitKey.slice(0, -IPV6_LIMIT_SUFFIX.length)}::`;
  if (isIP(network) !== 6) return limitKey;
  return ipv6PrefixKey(ipv6Groups(network), 3);
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
  return trustedNonEdgeIdentity(req);
}

function trustedNonEdgeIdentity(req: IncomingMessage): string {
  const socketPeer = normalizeIpAddress(req.socket.remoteAddress);
  const forwardedFor = req.headers['x-forwarded-for'];
  if (socketPeer && isPrivatePeerAddress(socketPeer) && typeof forwardedFor === 'string') {
    const appendedHop = normalizeIpAddress(forwardedFor.split(',').at(-1));
    if (appendedHop) return limitIdentity(appendedHop);
  }
  return socketPeer ? limitIdentity(socketPeer) : 'unknown';
}

/**
 * The address Cloudflare reports as `CF-Connecting-IP` for every request a
 * Worker on another zone sends us, whoever's Worker it is.
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests
 */
export const CLOUDFLARE_WORKER_EGRESS_ADDRESS = '2a06:98c0:3600::103';
const workerEgressGroups = ipv6Groups(CLOUDFLARE_WORKER_EGRESS_ADDRESS);

/** The whole address, in any spelling. The rest of its /64 is ordinary Cloudflare space, not the Worker address. */
function isWorkerEgressAddress(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const groups = ipv6Groups(address);
  return groups.every((group, index) => group === workerEgressGroups[index]);
}

const ZONE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_ZONE_LENGTH = 253;

/**
 * The zone a `CF-Worker` header names, lower-cased, or undefined unless it is
 * exactly one hostname of at least two labels. A repeated header reaches us
 * joined with a comma and is refused like any other malformed value.
 */
function workerZone(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const zone = header.trim().toLowerCase();
  if (zone.length === 0 || zone.length > MAX_ZONE_LENGTH) return undefined;
  const labels = zone.split('.');
  if (labels.length < 2 || !labels.every((label) => ZONE_LABEL.test(label))) return undefined;
  return zone;
}

export interface PartnerLimitIdentity {
  /** The bucket every per-address partner limit counts. */
  key: string;
  /**
   * Set only for a request from a Cloudflare Worker: the Worker egress
   * address's own limit identity. The zone header is the Worker's to write, so
   * the caller also counts every zone together against a ceiling on this.
   */
  sharedEgress?: string;
}

/**
 * The identity the partner OAuth limits count. Every Worker on another zone
 * reaches us from one `CF-Connecting-IP`, so keyed by address alone all
 * Worker-hosted apps would share one bucket worldwide. For that one address,
 * from a verified Cloudflare edge only, the bucket is the `CF-Worker` zone
 * instead. Anything else, including a `CF-Worker` header from any other
 * address or from a request that did not come through Cloudflare, gets exactly
 * `getTrustedClientIp`.
 */
export function getPartnerLimitIdentity(req: IncomingMessage): PartnerLimitIdentity {
  const edgeVisitor = resolveEdgeVisitorIp(req);
  if (!edgeVisitor) return { key: trustedNonEdgeIdentity(req) };
  const addressIdentity = limitIdentity(edgeVisitor);
  if (!isWorkerEgressAddress(edgeVisitor)) return { key: addressIdentity };
  const zone = workerZone(req.headers['cf-worker']);
  return zone ? { key: `cf-worker:${zone}`, sharedEgress: addressIdentity } : { key: addressIdentity };
}
