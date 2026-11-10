import { lookup } from 'node:dns/promises';

// Hostname allowlists for the platforms whose thumbnails we cache. Each entry
// matches the *exact* hostname (case-insensitive) — wildcard support is
// expressed as a regex. Anything outside these patterns is rejected before we
// even resolve DNS, which is the first line of defense against SSRF via
// attacker-controlled `og:image` URLs.
const HOST_ALLOWLISTS: Record<ImageHostKind, RegExp> = {
  // Facebook / Instagram CDN. og:image on canonical IG posts and the embed
  // path both currently come back from these hostnames.
  instagram: /^[a-z0-9-]+\.(fbcdn\.net|cdninstagram\.com)$/i,
  // TikTok oEmbed thumbnails. Hosts like p16-common-sign.tiktokcdn.com,
  // p16-sign.tiktokcdn.com, p16.tiktokcdn-us.com, p16-sign.tiktokcdn-eu.com
  // all show up in practice — the EU CDN serves thumbnails for posts viewed
  // from European IPs, and the dev proxy already treats it as valid.
  tiktok: /^[a-z0-9-]+\.(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com)$/i,
  // Profile pictures drawn on share cards: our media CDN, and the Google OAuth
  // photo host a signed-in account's `users.image` points at. `avatarUrl` is
  // whatever the row holds, so nothing else may be fetched on its say-so.
  avatar: /^(media\.boardsesh\.com|[a-z0-9-]+\.googleusercontent\.com)$/i,
  // Gym photos and public spray wall photos drawn on share cards. Both are
  // objects we wrote to our own media bucket, so nothing else is needed here.
  'place-photo': /^media\.boardsesh\.com$/i,
};

export type ImageHostKind = 'instagram' | 'tiktok' | 'avatar' | 'place-photo';

export class UnsafeImageHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeImageHostError';
  }
}

/**
 * The host may answer differently in a moment: a failed DNS lookup, a 5xx or a
 * 429. Still a refusal for this request, but not a fact about the image.
 */
export class TransientImageFetchError extends UnsafeImageHostError {
  constructor(message: string) {
    super(message);
    this.name = 'TransientImageFetchError';
  }
}

// Returns true for IPs that should never be reachable from a server-side
// fetch initiated on behalf of a user — loopback, RFC1918 private space,
// link-local (incl. AWS instance metadata at 169.254.169.254), CGNAT,
// multicast, IPv6 loopback / unique-local / link-local. Pass an IP literal
// returned from `dns.lookup`, not a hostname.
export function isPrivateIp(addr: string): boolean {
  // IPv4
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + AWS IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 (multicast)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  // IPv6 — be conservative; reject loopback, unspecified, link-local (fe80::/10),
  // unique-local (fc00::/7), and IPv4-mapped private ranges.
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

// Validates that `url` is safe to fetch server-side and write back to a
// public S3 bucket. Throws UnsafeImageHostError on any failure. The check
// is two-layered:
//   1. Host pattern: reject anything outside the platform's CDN allowlist.
//      Cheap and catches the obvious cases without a DNS round-trip.
//   2. DNS resolution: reject if any A/AAAA record falls in a private /
//      reserved range. Defense in depth against DNS rebinding and against
//      a CDN hostname that's been pointed at an internal IP.
//
// Both layers must pass. The DNS check uses dns.lookup (Node's libuv-backed
// resolver) so /etc/hosts is honored — important in dev / CI.
//
// Known limitation (TOCTOU): the DNS resolution here and the subsequent
// `fetch(url)` call in cacheRemoteThumbnail are separate steps. A DNS
// rebinding attacker who controls an authoritative server with a very
// short TTL could in principle return a public IP for our lookup and a
// private IP for fetch's own resolution. Mitigating this fully requires
// resolving the IP here and then making fetch connect to that exact IP
// (with the original Host header), which Node's fetch doesn't expose
// cleanly. Combined with the host allowlist (only fbcdn.net /
// cdninstagram.com / tiktokcdn.com / tiktokcdn-eu.com — domains controlled by Meta /
// ByteDance, not attackers) the residual risk is low; we accept it as
// a known trade-off rather than reach for a custom socket dialer.
export async function assertAllowedImageHost(rawUrl: string, kind: ImageHostKind): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeImageHostError(`Invalid image URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new UnsafeImageHostError(`Refusing non-https image URL: ${rawUrl}`);
  }

  if (!HOST_ALLOWLISTS[kind].test(parsed.hostname)) {
    throw new UnsafeImageHostError(`Host ${parsed.hostname} is not in the ${kind} allowlist`);
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new TransientImageFetchError(`Could not resolve ${parsed.hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UnsafeImageHostError(`Refusing image fetch: ${parsed.hostname} resolves to private IP ${address}`);
    }
  }
}

/**
 * Read a response body with a hard byte cap. Wall-clock is bounded by the fetch
 * timeout but bytes aren't, so without this a hostile server over a fast pipe
 * could exhaust memory before the timeout fires. Null when the cap is exceeded.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (res.body) {
    const reader = res.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best-effort
        }
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  // Fallback for environments / mocks where `res.body` isn't a ReadableStream.
  // Fetch the whole buffer, then enforce the cap on the result. Less
  // protective than streaming (the byte cap doesn't help if Node already
  // buffered the whole response) but at least keeps the runtime check in
  // place for the upload step.
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) return null;
  return Buffer.from(arrayBuffer);
}

/**
 * Fetch an image for an internal purpose, or throw. On top of
 * `assertAllowedImageHost`: a short timeout, no redirects (a redirect could point
 * back into the private network, and the allowlist only judged the first hop), a
 * declared image content type, a byte cap, and a non-empty body. The bytes are
 * still attacker-influenced: the caller decodes them with a pixel limit.
 */
export async function fetchAllowedImage(
  rawUrl: string,
  kind: ImageHostKind,
  options: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> {
  await assertAllowedImageHost(rawUrl, kind);
  const response = await fetch(rawUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { Accept: 'image/*' },
  });
  if (!response.ok) {
    const failure = `Image fetch answered ${response.status}`;
    if (response.status >= 500 || response.status === 429) throw new TransientImageFetchError(failure);
    throw new UnsafeImageHostError(failure);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new UnsafeImageHostError(`Refusing non-image content type: ${contentType}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > options.maxBytes) throw new UnsafeImageHostError('Declared image size exceeds the cap');
  const bytes = await readBodyWithCap(response, options.maxBytes);
  if (!bytes) throw new UnsafeImageHostError('Image exceeds the byte cap');
  if (bytes.length === 0) throw new UnsafeImageHostError('Image response was empty');
  return bytes;
}
