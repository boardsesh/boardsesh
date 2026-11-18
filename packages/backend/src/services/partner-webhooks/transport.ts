import { resolveAddresses } from '../../lib/resolve-addresses';
import { request, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';

const forbidden = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  forbidden.addSubnet(address, prefix);
forbidden.addAddress('168.63.129.16'); // Azure's host-internal virtual service address.
forbidden.addSubnet('2001::', 23, 'ipv6'); // Special-purpose and transition ranges.
forbidden.addSubnet('2001:db8::', 32, 'ipv6');
forbidden.addSubnet('2002::', 16, 'ipv6'); // 6to4 can encode a private IPv4 target.
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

export class UnsafeWebhookUrlError extends Error {
  constructor() {
    super('Webhook URLs must use public HTTPS on port 443.');
    this.name = 'UnsafeWebhookUrlError';
  }
}

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !forbidden.check(address, 'ipv4');
  // Also rejects every IPv4-mapped address, including its hexadecimal forms.
  return family === 6 && globalIpv6.check(address, 'ipv6') && !forbidden.check(address, 'ipv6');
}

export function parseWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    if (rawUrl.length > 2048) throw new UnsafeWebhookUrlError();
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError();
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.port && parsed.port !== '443') ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new UnsafeWebhookUrlError();
  }
  return parsed;
}

type Address = { address: string; family: number };
export type WebhookResolver = (hostname: string) => Promise<Address[]>;
/** Validate every answer and return the exact address the HTTPS connection must use. */
export async function resolveWebhookTarget(
  rawUrl: string,
  resolve: WebhookResolver = resolveAddresses,
): Promise<{ url: URL; address: Address }> {
  const url = parseWebhookUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolve(hostname);
  if (
    addresses.length === 0 ||
    addresses.length > 32 ||
    addresses.some(({ address }) => !isPublicWebhookAddress(address))
  ) {
    throw new UnsafeWebhookUrlError();
  }
  return { url, address: addresses[0] };
}

/** DNS, TLS and response headers all share one deadline; redirects are returned, never followed. */
export async function postWebhook(rawUrl: string, rawBody: string, headers: Record<string, string>): Promise<number> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 10_000);
  deadline.unref();
  try {
    const target = await Promise.race([
      resolveWebhookTarget(rawUrl),
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('Webhook deadline exceeded')), { once: true });
      }),
    ]);
    if (abort.signal.aborted) throw new Error('Webhook deadline exceeded');
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
    return await new Promise<number>((resolve, reject) => {
      const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: 'https:',
        hostname,
        port: '443',
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        agent: false,
        autoSelectFamily: false,
        servername: isIP(hostname) ? undefined : hostname,
        family: target.address.family,
        // TLS still verifies the original hostname; there is no second DNS resolution.
        lookup: (_hostname, _options, callback) => callback(null, target.address.address, target.address.family),
        signal: abort.signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(rawBody)),
        },
      };
      const outgoing = request(requestOptions, (response) => {
        const status = response.statusCode ?? 502;
        // We only need the status. Never buffer a hostile endpoint's body.
        response.destroy();
        resolve(status);
      });
      outgoing.once('error', reject);
      outgoing.end(rawBody);
    });
  } finally {
    clearTimeout(deadline);
  }
}
