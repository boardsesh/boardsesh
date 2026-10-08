import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

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
 * Accept country only from Cloudflare itself or our private ingress whose last
 * XFF hop is the peer it observed (the same append contract as client-ip.ts).
 * Direct-origin visitors and client-authored earlier XFF entries cannot claim
 * an edge country. Deployments without an appending private ingress fail closed.
 * This coarse flag input never carries the visitor's IP upstream.
 */
export function resolveFlagCountry(req: IncomingMessage): string {
  const socketPeer = normalizeAddress(req.socket.remoteAddress);
  const forwardedFor = req.headers['x-forwarded-for'];
  const ingressPeer = typeof forwardedFor === 'string' ? normalizeAddress(forwardedFor.split(',').at(-1)) : undefined;
  const trustedEdge =
    includesAddress(cloudflarePeers, socketPeer) ||
    (includesAddress(privatePeers, socketPeer) && includesAddress(cloudflarePeers, ingressPeer));
  const country = req.headers['cf-ipcountry'];
  return trustedEdge &&
    typeof country === 'string' &&
    /^[A-Z]{2}$/.test(country) &&
    country !== 'XX' &&
    country !== 'ZZ'
    ? country
    : 'XX';
}
