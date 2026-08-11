import { logger } from '../utils/logger';

/**
 * Per-IP ceiling on **concurrent anonymous WebSocket connections** (issue #4035).
 *
 * The #2863 work (see `client-ip.ts`) bounded the *rate* of anonymous operations
 * by keying tier-1 rate limits on a trusted client IP. It left the *count* of
 * live anonymous sockets unbounded: every accepted connection costs a
 * room-manager registration plus subscription bookkeeping, so one caller could
 * pin arbitrarily much server state open without ever issuing an operation.
 *
 * Two tiers, mirroring the dual-tier rate limits in
 * `graphql/resolvers/shared/helpers.ts`:
 *
 * 1. **Per client IP** (`resolveWebSocketClientIp`, IPv6 truncated to `/64`) —
 *    enforced. Default 200, which has to clear a busy gym's NAT and a carrier
 *    CGNAT region, since every open board page holds a socket.
 * 2. **Per TCP peer** (`resolveWebSocketSocketPeerIp`, header-free) — a backstop
 *    against a direct-origin caller rotating a forged `cf-connecting-ip`.
 *    **Warn-only by default.** In the hosted topology the TCP peer can be a
 *    shared Cloudflare/Railway edge address, which would make this tier an
 *    instance-global anonymous ceiling rather than a per-abuser one. It only
 *    rejects when `WS_ANON_CONNECTIONS_PER_SOCKET_PEER_ENFORCE=1`, so the
 *    overflow can be measured in production logs before it bites real traffic.
 *
 * ### Per-instance semantics
 *
 * The registry is in-process — same precedent as the tier-1 rate limiter — so
 * the effective global ceiling is `cap × instance count`. That is deliberate:
 * the goal is bounding *this instance's* state, and a Redis-backed counter
 * would strand slots after an instance crash (a permanently shrinking budget
 * that locks an IP out with no self-heal).
 *
 * ### Exemptions
 *
 * Authenticated users and validated API-key controllers never consume a slot —
 * a gym's wall controller must not be evicted by phones browsing on the same
 * NAT. Accepted residual: one valid account can still hold unlimited sockets,
 * consistent with rate limits keying authenticated traffic on `userId`.
 */

/** Tier that produced a cap decision. */
export type AnonConnectionCapTier = 'client-ip' | 'socket-peer';

export type AnonConnectionCapOverflow = {
  tier: AnonConnectionCapTier;
  /** Namespaced registry key, safe to log (an IP or IPv6 `/64`). */
  key: string;
  /** Slots held for `key` at decision time. */
  active: number;
  limit: number;
};

export type AnonConnectionCapResult =
  | { allowed: true; warning?: AnonConnectionCapOverflow }
  | { allowed: false; rejection: AnonConnectionCapOverflow };

export type AcquireAnonConnectionSlotArgs = {
  connectionId: string;
  clientIp?: string;
  socketPeerIp?: string;
};

const CLIENT_IP_CAP_DEFAULT = 200;
const SOCKET_PEER_CAP_DEFAULT = 1000;

const CLIENT_IP_CAP_ENV = 'WS_ANON_CONNECTIONS_PER_CLIENT_IP';
const SOCKET_PEER_CAP_ENV = 'WS_ANON_CONNECTIONS_PER_SOCKET_PEER';
const SOCKET_PEER_ENFORCE_ENV = 'WS_ANON_CONNECTIONS_PER_SOCKET_PEER_ENFORCE';

/** capKey → connectionIds currently holding a slot for it. */
const holdersByCapKey = new Map<string, Set<string>>();
/** connectionId → the capKeys it acquired, so release is O(1) and can't free a stranger's slot. */
const capKeysByConnectionId = new Map<string, string[]>();

/**
 * Read a cap from the environment on every acquisition. Caps change once per
 * deploy at most and acquisitions happen once per connection (not per
 * operation), so the parse cost is irrelevant next to the operability win of
 * being able to set the value without a code change.
 */
function readCap(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    logger.warn(`[WebSocket] Ignoring invalid ${envName}; falling back to ${fallback}`, { value: raw });
    return fallback;
  }
  return parsed;
}

type CapCandidate = {
  tier: AnonConnectionCapTier;
  key: string;
  limit: number;
  enforced: boolean;
};

function buildCandidates({
  clientIp,
  socketPeerIp,
}: Omit<AcquireAnonConnectionSlotArgs, 'connectionId'>): CapCandidate[] {
  const candidates: CapCandidate[] = [];

  // `resolveWebSocketClientIp` already falls back to the socket address, so
  // clientIp is only undefined when the peer address itself was unparseable —
  // unreachable on a real socket, but fall back rather than skip the tier.
  const clientKey = clientIp ?? socketPeerIp;
  if (clientKey) {
    candidates.push({
      tier: 'client-ip',
      key: `client:${clientKey}`,
      limit: readCap(CLIENT_IP_CAP_ENV, CLIENT_IP_CAP_DEFAULT),
      enforced: true,
    });
  }

  if (socketPeerIp) {
    candidates.push({
      tier: 'socket-peer',
      key: `peer:${socketPeerIp}`,
      limit: readCap(SOCKET_PEER_CAP_ENV, SOCKET_PEER_CAP_DEFAULT),
      enforced: process.env[SOCKET_PEER_ENFORCE_ENV] === '1',
    });
  }

  return candidates;
}

/**
 * Reserve a concurrent-connection slot for an anonymous WebSocket connection.
 *
 * Synchronous by construction: the caller must not `await` between deciding to
 * admit and this call, or interleaved `onConnect` runs would over-admit. Every
 * candidate tier is checked *before* any is committed, so a rejection on the
 * second tier can never leave a stray slot held on the first.
 *
 * Callers that get `allowed: true` MUST arrange for
 * {@link releaseAnonConnectionSlot} to run when the socket closes, including on
 * the paths where graphql-ws skips `onDisconnect` (any connection that never
 * reached `acknowledged`).
 */
export function tryAcquireAnonConnectionSlot({
  connectionId,
  clientIp,
  socketPeerIp,
}: AcquireAnonConnectionSlotArgs): AnonConnectionCapResult {
  const candidates = buildCandidates({ clientIp, socketPeerIp });
  // Nothing keyable (both identities unparseable). Admitting is the safe choice:
  // the alternative buckets every such caller under one sentinel key.
  if (candidates.length === 0) return { allowed: true };

  let warning: AnonConnectionCapOverflow | undefined;

  for (const candidate of candidates) {
    const holders = holdersByCapKey.get(candidate.key);
    // A re-acquire for the same connectionId occupies the slot it already holds.
    if (holders?.has(connectionId)) continue;
    const active = holders?.size ?? 0;
    if (active < candidate.limit) continue;

    const overflow: AnonConnectionCapOverflow = {
      tier: candidate.tier,
      key: candidate.key,
      active,
      limit: candidate.limit,
    };
    if (candidate.enforced) return { allowed: false, rejection: overflow };
    warning = overflow;
  }

  const acquiredKeys: string[] = capKeysByConnectionId.get(connectionId) ?? [];
  for (const candidate of candidates) {
    let holders = holdersByCapKey.get(candidate.key);
    if (!holders) {
      holders = new Set<string>();
      holdersByCapKey.set(candidate.key, holders);
    }
    holders.add(connectionId);
    if (!acquiredKeys.includes(candidate.key)) acquiredKeys.push(candidate.key);
  }
  capKeysByConnectionId.set(connectionId, acquiredKeys);

  return warning ? { allowed: true, warning } : { allowed: true };
}

/**
 * Free every slot a connection holds. Idempotent — a second call is a no-op —
 * because the release paths deliberately overlap (raw socket `close`, plus
 * `onDisconnect` as belt-and-braces). Empty holder sets are deleted so the
 * registry can't grow one entry per IP ever seen.
 */
export function releaseAnonConnectionSlot(connectionId: string): void {
  const capKeys = capKeysByConnectionId.get(connectionId);
  if (!capKeys) return;
  capKeysByConnectionId.delete(connectionId);

  for (const capKey of capKeys) {
    const holders = holdersByCapKey.get(capKey);
    if (!holders) continue;
    holders.delete(connectionId);
    if (holders.size === 0) holdersByCapKey.delete(capKey);
  }
}

/** Live slot count for a tier + identity. Exported for tests and diagnostics. */
export function countAnonConnectionSlots(tier: AnonConnectionCapTier, ip: string): number {
  const prefix = tier === 'client-ip' ? 'client' : 'peer';
  return holdersByCapKey.get(`${prefix}:${ip}`)?.size ?? 0;
}

/** Number of distinct keys held. Exported so tests can prove the registry drains. */
export function anonConnectionCapRegistrySize(): number {
  return holdersByCapKey.size + capKeysByConnectionId.size;
}

/** Drop all state. Test-only; production has no reason to forget live slots. */
export function resetAnonConnectionCapRegistry(): void {
  holdersByCapKey.clear();
  capKeysByConnectionId.clear();
}
