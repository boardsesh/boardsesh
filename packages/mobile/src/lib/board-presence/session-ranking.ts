import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

export type SessionRankingEntry = {
  /** Stable grouping key — the climber's userId when known, else their name. */
  key: string;
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
  sendCount: number;
  /**
   * Highest board-presence `seq` the climber appears at — the tie-break, so an
   * equal send count is broken toward the most recently active climber.
   */
  latestSeq: number;
};

/**
 * A per-climber "This session" leaderboard derived purely on the client from the
 * loaded board-presence history window: who has lit the most climbs on this wall,
 * ranked by send count then by most recent send (`seq`).
 *
 * Deliberately NOT grade-ranked. The presence feed carries only a display grade
 * string (e.g. "V5" / "7a"), with no reliable client-side ordering across boards
 * and angles — the "hardest" story is told by the backend `hardestSend` crown
 * (`BoardPresenceStats`) instead. Because this only sees the loaded pages, it is
 * a session-window view, not an all-time ranking, and callers must label it as
 * such ("This session").
 *
 * Sends with no attributed climber (no display name) are skipped — an anonymous
 * send can't rank. Pure and O(n), so it memoizes on the history array and unit-
 * tests without react-native.
 */
export function computeSessionRanking(history: readonly BoardPresenceClimb[], limit = 5): SessionRankingEntry[] {
  const byClimber = new Map<string, SessionRankingEntry>();
  for (const climb of history) {
    const displayName = climb.sentByDisplayName?.trim();
    if (!displayName) continue;
    const key = climb.sentByUserId ?? `name:${displayName}`;
    const existing = byClimber.get(key);
    if (existing) {
      existing.sendCount += 1;
      if (climb.seq > existing.latestSeq) existing.latestSeq = climb.seq;
    } else {
      byClimber.set(key, {
        key,
        userId: climb.sentByUserId ?? null,
        displayName,
        avatarUrl: climb.sentByAvatarUrl ?? null,
        sendCount: 1,
        latestSeq: climb.seq,
      });
    }
  }
  return [...byClimber.values()]
    .sort((left, right) => right.sendCount - left.sendCount || right.latestSeq - left.latestSeq)
    .slice(0, limit);
}
