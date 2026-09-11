// Cold-start hydration for the rest timer (#5378).
//
// Revived verbatim (minus the board-adapter merge helper) from the abandoned
// PR #2770. The problem it solves: reopen the app twenty seconds into a rest and
// the in-memory store has no anchor, so the pill would show "waiting for a tick"
// even though you just logged one. The session detail already knows when your
// last tick landed, so use it — but never let a stale server read rewind a live
// local anchor, which is what `getNewerTickAt` is for.

import { tickTimeMs } from '@boardsesh/profile-stats';

type SessionTickTimestamp = {
  userId?: string | null;
  climbedAt: string;
};

/**
 * The climber's OWN latest tick in a session. Filtering by user id is what keeps
 * a crew-mate's send from restarting your rest.
 */
export function getLatestUserSessionTickAt(
  ticks: readonly SessionTickTimestamp[] | undefined,
  userId: string | null | undefined,
): string | null {
  if (!ticks || !userId) return null;

  let latestTickAt: string | null = null;
  let latestTickMs = -Infinity;

  for (const tick of ticks) {
    if (tick.userId !== userId) continue;

    const tickMs = tickTimeMs(tick.climbedAt);
    if (!Number.isFinite(tickMs) || tickMs <= latestTickMs) continue;

    latestTickAt = tick.climbedAt;
    latestTickMs = tickMs;
  }

  return latestTickAt;
}

/** Whichever of the two is newer, tolerating nulls and unparseable timestamps. */
export function getNewerTickAt(firstTickAt: string | null, secondTickAt: string | null): string | null {
  if (!firstTickAt) return secondTickAt;
  if (!secondTickAt) return firstTickAt;

  const firstMs = tickTimeMs(firstTickAt);
  const secondMs = tickTimeMs(secondTickAt);

  if (!Number.isFinite(firstMs)) return Number.isFinite(secondMs) ? secondTickAt : null;
  if (!Number.isFinite(secondMs)) return firstTickAt;

  return firstMs >= secondMs ? firstTickAt : secondTickAt;
}
