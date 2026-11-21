import 'server-only';
import { isIPv6 } from 'node:net';
import { isCloudflareEdgeAddress, normalizeIpAddress } from '@boardsesh/consent/edge-country';
import { verifyOriginProof, type OriginProof } from '@boardsesh/consent/origin-proof-server';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from './origin-proof-header';
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

export { CLOUDFLARE_ORIGIN_PROOF_HEADER };
/** The web env var holding the proof our zone's transform adds. At least 32 bytes, or it counts as unset. */
export const CLOUDFLARE_ORIGIN_PROOF_SECRET_ENV = 'CLOUDFLARE_ORIGIN_PROOF_SECRET';
/**
 * A second accepted value, so a rotation has no gap: set this to the new value,
 * change the Cloudflare rule, then move it to the primary and unset this. Same
 * 32-byte rule.
 */
export const CLOUDFLARE_ORIGIN_PROOF_NEXT_SECRET_ENV = 'CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT';
/** How often the log may say a Cloudflare request arrived without our zone's proof. */
const UNPROVEN_WARNING_INTERVAL_MS = 60_000;

let lastUnprovenWarningAt = Number.NEGATIVE_INFINITY;
let unprovenSinceLastWarning = 0;

/**
 * A Cloudflare last hop without our zone's proof is either a caller that skipped
 * our zone or a sign that the transform rule is missing or holds another value.
 * The owner's turn-on check is that this never appears for real sign-ins.
 */
function warnUnprovenEdgeRequest(request: Request): void {
  unprovenSinceLastWarning += 1;
  const now = Date.now();
  if (now - lastUnprovenWarningAt < UNPROVEN_WARNING_INTERVAL_MS) return;
  lastUnprovenWarningAt = now;
  console.warn(
    JSON.stringify({
      event: 'cloudflare_origin_proof_missing',
      path: new URL(request.url).pathname,
      unprovenSinceLastWarning,
    }),
  );
  unprovenSinceLastWarning = 0;
}

/**
 * Whether our zone added this request's proof. `unconfigured` while neither
 * secret is set to at least 32 bytes. Call once per helper call: an unproven
 * request with a Cloudflare last hop is counted toward the warning.
 */
function originProof(request: Request): OriginProof {
  const proof = verifyOriginProof(request.headers.get(CLOUDFLARE_ORIGIN_PROOF_HEADER) ?? undefined, [
    process.env[CLOUDFLARE_ORIGIN_PROOF_SECRET_ENV],
    process.env[CLOUDFLARE_ORIGIN_PROOF_NEXT_SECRET_ENV],
  ]);
  if (proof === 'unproven' && isCloudflareEdgeAddress(lastForwardedHop(request))) warnUnprovenEdgeRequest(request);
  return proof;
}

function lastForwardedHop(request: Request): string | undefined {
  return normalizeIpAddress(request.headers.get('x-forwarded-for')?.split(',').at(-1));
}

function reportedVisitor(request: Request): string | undefined {
  return normalizeIpAddress(request.headers.get('cf-connecting-ip') ?? undefined);
}

/**
 * Rate-limit key a caller cannot choose. See docs/operations/cloudflare.md and the staged
 * requirements in docs/auth/better-auth-web-password-delegation.md.
 *
 * A route handler cannot see its socket peer. Our ingress appends the peer it
 * observed to `X-Forwarded-For`, so only the LAST hop is out of the caller's
 * reach. When that hop is a Cloudflare edge, the visitor is `CF-Connecting-IP`.
 * Otherwise the request went straight to the origin and the last hop is the
 * caller itself, whatever `CF-Connecting-IP` it sent.
 *
 * Once the origin proof secret is set (#7766), a Cloudflare last hop without our
 * zone's proof is keyed on that hop, never on the `CF-Connecting-IP` a Worker
 * could have written. While it is unset this behaves exactly as before.
 */
export function trustedClientRateLimitKey(request: Request): string {
  const lastHop = lastForwardedHop(request);
  if (!lastHop) return 'unknown';
  if (!isCloudflareEdgeAddress(lastHop)) return clientBucket(lastHop);
  if (originProof(request) === 'unproven') return clientBucket(lastHop);
  const visitor = reportedVisitor(request);
  return visitor ? clientBucket(visitor) : EDGE_WITHOUT_VISITOR_KEY;
}

/**
 * The visitor's address, exactly as Cloudflare reported it, when our own zone
 * vouches for it: the last `X-Forwarded-For` hop is a Cloudflare edge, the
 * request carries our zone's origin proof, and `CF-Connecting-IP` holds a usable
 * address. Otherwise null, including always while the proof secret is unset. Not
 * grouped: an IPv6 visitor keeps its whole address, for a caller that groups by
 * `/64` itself.
 *
 * Production reaches us as browser, Cloudflare (www is a proxied record in
 * infra/cloudflare/config.ts), the Railway edge, then this server. A caller can
 * also skip Cloudflare and hit the Railway domain directly, from anywhere,
 * including from a Worker inside Cloudflare's ranges that writes its own
 * `CF-Connecting-IP`. The proof is what tells our zone's traffic from that.
 * Railway's edge appends the peer it saw as the last hop; that was checked for the
 * backend service on 2026-11-10, not yet for this one
 * (docs/auth/better-auth-web-password-delegation.md). If it appends its own address
 * instead, no last hop is a Cloudflare edge and this is always null.
 */
export function cloudflareVouchedVisitorAddress(request: Request): string | null {
  if (originProof(request) !== 'proven') return null;
  const lastHop = lastForwardedHop(request);
  if (!lastHop || !isCloudflareEdgeAddress(lastHop)) return null;
  return reportedVisitor(request) ?? null;
}

/**
 * The bucket of a visitor a Cloudflare edge reports, or null.
 *
 * `trustedClientRateLimitKey` falls back to values every caller can share: the
 * constant `unknown` with no forwarded hop, one fixed bucket for an edge request
 * with no visitor, and the last hop itself, which is our ingress's own address
 * if the web ingress appends that rather than the peer it observed. Nobody has
 * yet checked which one the web service sees in production (see
 * docs/auth/better-auth-web-password-delegation.md), so a limit that must never put
 * every visitor in one bucket keys on this instead and skips when it is null.
 *
 * While the origin proof secret is unset this behaves exactly as before: any
 * Cloudflare last hop is believed, which a Worker can exploit (#7766). Once it
 * is set, a request without our zone's proof is keyed on its last hop (or
 * `unknown`), never null, so the legacy sign-in limit cannot be skipped by
 * leaving the proof out or using a path the rule misses.
 */
export function cloudflareVisitorRateLimitKey(request: Request): string | null {
  const lastHop = lastForwardedHop(request);
  // Configured and unproven: not our zone's traffic, since real visitors carry
  // the proof. Limit it on the hop our ingress saw; never skip it.
  if (originProof(request) === 'unproven') return lastHop ? clientBucket(lastHop) : 'unknown';
  if (!lastHop || !isCloudflareEdgeAddress(lastHop)) return null;
  const visitor = reportedVisitor(request);
  return visitor ? clientBucket(visitor) : null;
}

/** Null unless staged email auth is on, so legacy routes keep their existing limiter input. */
export function stagedPasswordClientKey(request: Request): string | null {
  try {
    return webPasswordMode() === 'backend-staging' ? trustedClientRateLimitKey(request) : null;
  } catch {
    return null;
  }
}
