// Pure leaderboard shaping for the kiosk rail — session and period modes both
// reduce to the same row model so the rail renders one list either way.
// No React; unit-tested with fixture histories/leaderboards.

import { rankSessionClimbers, type RankedSessionClimber } from '@boardsesh/board-presence';
import type { BoardLeaderboard, BoardPresenceClimb } from '@boardsesh/shared-schema';

export const KIOSK_LEADERBOARD_MAX_ROWS = 10;

export type KioskLeaderboardRowData = {
  /** Stable row key: the user id when known, else a name-scoped fallback. */
  key: string;
  /** Null when the sender was anonymous — the UI localizes the fallback. */
  displayName: string | null;
  avatarUrl: string | null;
  sendCount: number;
  /** Only present in single-board period scope (grades don't merge across boards). */
  hardestGradeName: string | null;
};

/**
 * Live session ranking: merge the per-board presence histories and rank
 * climbers by distinct sends inside the rolling window.
 *
 * Visibility limit: each board's history is capped at 50 entries (HISTORY_CAP
 * in @boardsesh/board-presence), so on a wall with more than 50 sends inside
 * the session window the oldest ones fall off the ranking. Acceptable for a
 * gym-session leaderboard; deeper windows would need `boardHistory` paging.
 */
export function buildSessionLeaderboardRows(
  histories: BoardPresenceClimb[][],
  options: { windowMinutes: number; now: Date; maxRows?: number },
): KioskLeaderboardRowData[] {
  const merged = histories.flat();
  const ranked = rankSessionClimbers(merged, { windowMinutes: options.windowMinutes, now: options.now });
  return ranked.slice(0, options.maxRows ?? KIOSK_LEADERBOARD_MAX_ROWS).map(sessionClimberToRow);
}

function sessionClimberToRow(climber: RankedSessionClimber): KioskLeaderboardRowData {
  return {
    key: climber.userId !== null ? `user:${climber.userId}` : `name:${climber.displayName ?? ''}`,
    displayName: climber.displayName,
    avatarUrl: climber.avatarUrl,
    sendCount: climber.sendCount,
    hardestGradeName: null,
  };
}

/**
 * Period ranking (Last 24 hours / week / month): merge the per-board
 * `boardLeaderboard` results by user id, summing sends. Grades only survive a
 * SINGLE-board scope — hardest-grade is dropped when boards merge, because
 * per-board grade scales aren't comparable enough to take a cross-board max.
 */
export function mergePeriodLeaderboards(
  leaderboards: BoardLeaderboard[],
  options: { maxRows?: number } = {},
): KioskLeaderboardRowData[] {
  const isSingleBoardScope = leaderboards.length === 1;
  const rowsByUserId = new Map<string, KioskLeaderboardRowData>();

  for (const leaderboard of leaderboards) {
    for (const entry of leaderboard.entries) {
      // Combine anonymous contributions without inventing an identity that
      // could link a private climber across boards or time windows.
      const key = entry.userId ? `user:${entry.userId}` : 'private-climbers';
      const existing = rowsByUserId.get(key);
      if (existing === undefined) {
        rowsByUserId.set(key, {
          key,
          displayName: entry.userDisplayName ?? null,
          avatarUrl: entry.userAvatarUrl ?? null,
          sendCount: entry.totalSends,
          hardestGradeName: isSingleBoardScope ? (entry.hardestGradeName ?? null) : null,
        });
        continue;
      }
      existing.sendCount += entry.totalSends;
      existing.displayName = existing.displayName ?? entry.userDisplayName ?? null;
      existing.avatarUrl = existing.avatarUrl ?? entry.userAvatarUrl ?? null;
    }
  }

  return Array.from(rowsByUserId.values())
    .sort((first, second) => {
      if (second.sendCount !== first.sendCount) return second.sendCount - first.sendCount;
      // Deterministic tie-break so rows don't shuffle between refetches.
      return first.key.localeCompare(second.key);
    })
    .slice(0, options.maxRows ?? KIOSK_LEADERBOARD_MAX_ROWS);
}

/**
 * Reduce the settled per-board `boardLeaderboard` fetches to merged rows.
 * Partial failure is tolerated — the ranking narrows to the boards that
 * answered (a temporarily unreachable board should not blank the whole rail).
 * When EVERY board failed this throws, so the caller (React Query) surfaces
 * an error state distinguishable from a genuine "nobody climbed" empty
 * ranking. An empty input (zero scoped boards) merges to no rows.
 */
export function mergeSettledPeriodLeaderboards(
  settled: ReadonlyArray<PromiseSettledResult<{ boardLeaderboard: BoardLeaderboard }>>,
): KioskLeaderboardRowData[] {
  const leaderboards: BoardLeaderboard[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      leaderboards.push(result.value.boardLeaderboard);
    }
  }
  if (leaderboards.length === 0 && settled.length > 0) {
    throw new Error('kiosk period leaderboard: all board fetches failed');
  }
  return mergePeriodLeaderboards(leaderboards);
}
