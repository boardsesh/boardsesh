import { normalizeRateLimitIp } from '@boardsesh/rate-limit';
import type { IncomingMessage } from 'node:http';

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
  return normalizeRateLimitIp(raw);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  // Defensive only: Node joins duplicate request headers into a single
  // comma-separated string (set-cookie is the sole array-valued header), so the
  // array branch is a type-level shape rather than a reachable one.
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Resolve the client IP of an incoming request for rate-limit keying. Named for
 * the WebSocket upgrade it was written for; `packages/backend/src/graphql/yoga.ts`
 * now calls it with the Node request behind `yoga.handle` so both transports
 * share one trust boundary (issue #4034).
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
 * also pin a *victim's* IP to exhaust their bucket. HTTP had the same defect
 * until issue #4034 pointed `yoga.ts` at this resolver.
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

/**
 * Resolve only the WebSocket upgrade's TCP peer. Unlike
 * {@link resolveWebSocketClientIp}, this never consults request headers, so a
 * client reaching the origin directly cannot rotate it by forging proxy
 * metadata. At the hosted Railway origin this may identify an edge proxy, so
 * callers must use it only for a deliberately high secondary ceiling.
 */
export function resolveWebSocketSocketPeerIp(req?: IncomingMessage): string | undefined {
  return normalizeClientIp(req?.socket?.remoteAddress);
}
