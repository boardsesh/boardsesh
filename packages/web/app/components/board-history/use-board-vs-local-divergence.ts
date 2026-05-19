'use client';

import { useMemo } from 'react';
import type { BoardHistoryEntry } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../queue-control/types';
import { useBoardHistory } from './use-board-history';
import { useCurrentClimb } from '../graphql-queue';

export type BoardVsLocalDivergence = {
  /** Latest entry the wall has actually seen, regardless of who sent it. */
  boardCurrent: BoardHistoryEntry | null;
  /** The user's current local pick — what would go up if they sent now. */
  localPick: ClimbQueueItem | null;
  /**
   * True iff both sides are non-null AND they differ on `(climbUuid, angle)`.
   * If either side is null, divergent is false — there's nothing meaningful
   * to compare and we don't want to surface a confusing dot.
   *
   * Note: when shared-playlist mode is ON, the local pick IS the shared
   * queue's current item which IS what gets sent to the board. The two
   * sources naturally converge, so this comparison returns false. No
   * special-case branch is needed — the equality check handles it.
   */
  divergent: boolean;
};

/**
 * Compare the wall's current state against the user's local pick.
 *
 * Reads `useBoardHistory().latestEntry` and the queue context's
 * `currentClimbQueueItem`. Returns the two values plus a derived `divergent`
 * boolean used to drive the divergence dot on the queue control bar and the
 * two-line layout in `<CurrentlyOnBoardHeader>`.
 */
export function useBoardVsLocalDivergence(): BoardVsLocalDivergence {
  const { latestEntry } = useBoardHistory();
  const { currentClimbQueueItem } = useCurrentClimb();

  return useMemo<BoardVsLocalDivergence>(() => {
    const boardCurrent = latestEntry ?? null;
    const localPick = currentClimbQueueItem ?? null;

    if (!boardCurrent || !localPick) {
      return { boardCurrent, localPick, divergent: false };
    }

    const sameClimb = boardCurrent.climbUuid === localPick.climb.uuid;
    const sameAngle = boardCurrent.angle === localPick.climb.angle;
    const divergent = !(sameClimb && sameAngle);
    return { boardCurrent, localPick, divergent };
  }, [latestEntry, currentClimbQueueItem]);
}
