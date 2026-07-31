import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * Number of leading IPv6 hextets kept when building a rate-limit key. A single
 * customer is routinely handed a routed /64, so keying on the full /128 would
 * let one client mint 2^64 buckets.
 */
const IPV6_PREFIX_HEXTETS = 4;
const IPV6_TOTAL_HEXTETS = 8;

/**
 * Expand an IPv6 address to its 8 hextets, resolving the `::` run and any
 * embedded trailing IPv4 (`2001:db8::192.0.2.1`). Returns undefined for shapes
 * that don't expand cleanly, which makes the caller fall through rather than
 * mint a nonsense key.
 */
function expandIpv6Hextets(address: string): string[] | undefined {
  const runSplit = address.split('::');
  if (runSplit.length > 2) return undefined;

  const splitGroups = (part: string): string[] => (part ? part.split(':') : []);

  // A trailing dotted-quad occupies two hextets.
  const expandTrailingIpv4 = (groups: string[]): string[] => {
    const lastGroup = groups.at(-1);
    if (!lastGroup?.includes('.')) return groups;
    const octets = lastGroup.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return groups;
    }
    return [
      ...groups.slice(0, -1),
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16),
      (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16),
    ];
  };

  const leadingHextets = expandTrailingIpv4(splitGroups(runSplit[0] ?? ''));
  if (runSplit.length === 1) {
    return leadingHextets.length === IPV6_TOTAL_HEXTETS ? leadingHextets : undefined;
  }

  const trailingHextets = expandTrailingIpv4(splitGroups(runSplit[1] ?? ''));
  const zeroRunLength = IPV6_TOTAL_HEXTETS - leadingHextets.length - trailingHextets.length;
  if (zeroRunLength < 0) return undefined;
  return [...leadingHextets, ...Array<string>(zeroRunLength).fill('0'), ...trailingHextets];
}

/**
 * Turn a raw header/socket value into a stable rate-limit key component, or
 * undefined when it isn't an IP at all (so the caller tries the next
 * candidate instead of turning junk into a permanent map key).
 *
 * - strips surrounding brackets and any `%zone` suffix
 * - unwraps IPv4-mapped IPv6 (`::ffff:203.0.113.5` → `203.0.113.5`) so the
 *   socket-fallback path and the header path agree on one bucket
 * - truncates IPv6 to its /64 prefix
 */
export function normalizeClientIp(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const withoutBrackets = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  const withoutZone = withoutBrackets.split('%')[0] ?? '';
  const lowercased = withoutZone.toLowerCase();
  // Only unwrap when the tail is genuinely dotted-quad IPv4. The hex form
  // (`::ffff:c000:0201`) is a valid IPv6 literal whose tail is not an IP, so
  // stripping unconditionally would drop it instead of keying its /64.
  const mappedIpv4Tail = lowercased.startsWith('::ffff:') ? lowercased.slice('::ffff:'.length) : undefined;
  const unwrapped = mappedIpv4Tail !== undefined && isIP(mappedIpv4Tail) === 4 ? mappedIpv4Tail : lowercased;

  const family = isIP(unwrapped);
  if (family === 0) return undefined;
  if (family === 4) return unwrapped;

  const hextets = expandIpv6Hextets(unwrapped);
  if (!hextets) return undefined;
  const prefix = hextets
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((hextet) => hextet.replace(/^0+(?=.)/, ''))
    .join(':');
  return `${prefix}::/64`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  // Defensive only: Node joins duplicate request headers into a single
  // comma-separated string (set-cookie is the sole array-valued header), so the
  // array branch is a type-level shape rather than a reachable one.
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Resolve the client IP of a WebSocket upgrade request for rate-limit keying.
 *
 * Trusted-hop order — mirrors `packages/backend/src/handlers/og-climb.ts`:
 *   1. `cf-connecting-ip` — Cloudflare overwrites this header, and Cloudflare
 *      currently fronts ws.boardsesh.com with Railway's edge behind it.
 *   2. else the LAST `x-forwarded-for` hop — our edge appends the address it
 *      observed; every earlier entry is client-authored.
 *   3. else `req.socket.remoteAddress`.
 *   4. else undefined, so `applyRateLimit` can fall through to its
 *      connectionId branch rather than bucketing everyone under one sentinel.
 *
 * Why not the FIRST x-forwarded-for hop: it is attacker-controlled. A scripted
 * client can set `x-forwarded-for: <random>` on each upgrade and mint a fresh
 * bucket every time — exactly the bypass issue #2863 exists to close — and can
 * also pin a *victim's* IP to exhaust their bucket. This deliberately diverges
 * from `packages/backend/src/graphql/yoga.ts`, whose HTTP anonymous derivation
 * still trusts the first hop; that is the same defect on the HTTP transport and
 * is tracked separately.
 *
 * Residual: a client that reaches the Railway origin directly, bypassing
 * Cloudflare, can spoof `cf-connecting-ip` (same caveat as og-climb.ts).
 *
 * `x-real-ip` is deliberately not consulted — nothing in our chain sets it, so
 * it is pure spoof surface.
 */
export function resolveWebSocketClientIp(req?: IncomingMessage): string | undefined {
  const cloudflareIp = normalizeClientIp(headerValue(req?.headers['cf-connecting-ip']));
  if (cloudflareIp) return cloudflareIp;

  const forwardedChain = headerValue(req?.headers['x-forwarded-for']);
  const lastForwardedHop = normalizeClientIp(forwardedChain?.split(',').at(-1));
  if (lastForwardedHop) return lastForwardedHop;

  return normalizeClientIp(req?.socket?.remoteAddress);
}
