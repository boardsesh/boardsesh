/**
 * Tracks how many concurrent `climbStatsUpdated` subscriptions each WS
 * connection holds open. Caps the total so a logged-in attacker can't
 * sweep every layout on every board and pin server memory with subscriber
 * Sets — see the scalability review on PR #2218.
 *
 * Lives in-process per backend instance. Counters reset implicitly when
 * the connection disconnects because subscription resolvers run the
 * finally-block on iterator return().
 */
const counts = new Map<string, number>();

/** Legit clients hold ~1–3 (one per open board-page tab). 8 is a generous
 *  ceiling that still blocks the per-connection sweep attack. */
export const MAX_SUBS_PER_CONNECTION = 8;

export function incrementConnectionSubCount(connectionId: string): void {
  const current = counts.get(connectionId) ?? 0;
  if (current >= MAX_SUBS_PER_CONNECTION) {
    throw new Error(`Too many climb-stats subscriptions on this connection (max ${MAX_SUBS_PER_CONNECTION})`);
  }
  counts.set(connectionId, current + 1);
}

export function decrementConnectionSubCount(connectionId: string): void {
  const current = counts.get(connectionId) ?? 0;
  if (current <= 1) {
    counts.delete(connectionId);
  } else {
    counts.set(connectionId, current - 1);
  }
}

export function getConnectionSubCount(connectionId: string): number {
  return counts.get(connectionId) ?? 0;
}
