import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { CONSENT_REGION_EDGE_HEADER_NAME } from '@boardsesh/consent';

// https://www.cloudflare.com/ips-v4/ and /ips-v6/, checked 2026-10-08.
// An outdated list fails closed for newly introduced edge ranges.
const cloudflarePeers = new BlockList();
for (const subnet of [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]) {
  const [address, prefix] = subnet.split('/');
  cloudflarePeers.addSubnet(address!, Number(prefix), isIP(address!) === 4 ? 'ipv4' : 'ipv6');
}

const privatePeers = new BlockList();
privatePeers.addSubnet('10.0.0.0', 8);
privatePeers.addSubnet('172.16.0.0', 12);
privatePeers.addSubnet('192.168.0.0', 16);
privatePeers.addSubnet('127.0.0.0', 8);
privatePeers.addSubnet('fc00::', 7, 'ipv6');
privatePeers.addAddress('::1', 'ipv6');

// Addresses PostHog cannot place, beyond the private ranges above: link-local,
// carrier-grade NAT and the unspecified addresses. No ::ffff:0:0/96 entry: Node's
// BlockList already matches IPv4-mapped IPv6 (dotted or hex) against these IPv4
// subnets, and that entry would match every plain IPv4 address too.
const nonPublicPeers = new BlockList();
nonPublicPeers.addSubnet('169.254.0.0', 16);
nonPublicPeers.addSubnet('100.64.0.0', 10);
nonPublicPeers.addSubnet('0.0.0.0', 8);
nonPublicPeers.addSubnet('fe80::', 10, 'ipv6');
nonPublicPeers.addAddress('::', 'ipv6');

function normalizeAddress(address: string | undefined): string | undefined {
  const normalized = address
    ?.trim()
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return normalized && isIP(normalized) ? normalized : undefined;
}

function includesAddress(peers: BlockList, address: string | undefined): boolean {
  return !!address && peers.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * True when this request reached us from a Cloudflare edge: the socket peer is
 * Cloudflare itself, or it is our private ingress and the last XFF hop (the
 * peer that ingress observed, the same append contract as client-ip.ts) is
 * Cloudflare. Only then are Cloudflare's own headers (`cf-ipcountry`,
 * `cf-connecting-ip`) trustworthy. Direct-origin visitors and client-authored
 * earlier XFF entries cannot pass. Deployments without an appending private
 * ingress fail closed.
 */
export function isTrustedCloudflareEdge(req: IncomingMessage): boolean {
  const socketPeer = normalizeAddress(req.socket.remoteAddress);
  const forwardedFor = req.headers['x-forwarded-for'];
  const ingressPeer = typeof forwardedFor === 'string' ? normalizeAddress(forwardedFor.split(',').at(-1)) : undefined;
  return (
    includesAddress(cloudflarePeers, socketPeer) ||
    (includesAddress(privatePeers, socketPeer) && includesAddress(cloudflarePeers, ingressPeer))
  );
}

/**
 * The visitor address Cloudflare reports (`cf-connecting-ip`), only from a
 * trusted edge and only when it is a public address PostHog can geolocate.
 * Null otherwise: a caller-chosen XFF hop, a private or loopback address, or
 * a request that did not come through Cloudflare.
 */
export function resolveEdgeVisitorIp(req: IncomingMessage): string | null {
  if (!isTrustedCloudflareEdge(req)) return null;
  const connecting = req.headers['cf-connecting-ip'];
  const address = normalizeAddress(typeof connecting === 'string' ? connecting : undefined);
  if (!address || includesAddress(privatePeers, address) || includesAddress(nonPublicPeers, address)) return null;
  return address;
}

/**
 * Accept country only from a trusted Cloudflare edge ({@link isTrustedCloudflareEdge}).
 * This coarse flag input never carries the visitor's IP upstream.
 *
 * GraphQL HTTP requests carry the same value as `ConnectionContext.edgeCountry`,
 * which `consentRegion` turns into the analytics-prompt decision.
 */
export function resolveFlagCountry(req: IncomingMessage): string {
  const trustedEdge = isTrustedCloudflareEdge(req);
  const country = req.headers['cf-ipcountry'];
  return trustedEdge &&
    typeof country === 'string' &&
    /^[A-Z]{2}$/.test(country) &&
    country !== 'XX' &&
    country !== 'ZZ'
    ? country
    : 'XX';
}

/**
 * Coarse subdivision from our verified GraphQL edge overwrite/remove rule.
 * An operator must apply that rule before enabling BOARDSESH_TRUST_EDGE_REGION_HEADER.
 * Ignore the optional cf-region-code header: a trusted edge hop does not prove
 * its visitor-location managed transform was enabled to overwrite caller input.
 */
export function resolveEdgeRegionCode(req: IncomingMessage): string | undefined {
  if (!isTrustedCloudflareEdge(req)) return undefined;
  if (
    process.env.BOARDSESH_TRUST_EDGE_REGION_HEADER !== 'true' ||
    req.headers.host !== 'ws.boardsesh.com' ||
    req.url?.split('?')[0] !== '/graphql'
  )
    return undefined;
  const regionCode = req.headers[CONSENT_REGION_EDGE_HEADER_NAME];
  return typeof regionCode === 'string' && /^[A-Z0-9]{1,3}$/.test(regionCode) ? regionCode : undefined;
}
