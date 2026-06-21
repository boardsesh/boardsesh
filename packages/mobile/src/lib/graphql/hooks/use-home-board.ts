import { useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useAuth } from '../../../providers/auth-provider';
import { useActiveBoard } from '../use-active-board';
import { useMyBoards, useProfile } from './index';
import { useAllBoardsTicks } from './use-you-data';

export type HomeBoardResult = {
  /** The board the home feed scopes to by default, or `null` when none can be
   *  inferred (no active board, no ticks, and not exactly one owned board). */
  board: UserBoard | null;
  /** Every board the user owns. Shares the `useMyBoards` cache the inference
   *  already reads, so consumers don't subscribe to that query a second time. */
  boards: UserBoard[];
  /** True while the inputs the inference depends on are still loading. */
  isResolving: boolean;
};

// Referentially stable empty list so the returned `boards` keeps the same
// reference across renders while `useMyBoards` has no data — a fresh `[]` would
// bust consumers memoising on it.
const EMPTY_BOARDS: UserBoard[] = [];

function boardActivity(board: UserBoard): number {
  return board.uniqueClimbers || board.totalAscents || 0;
}

/**
 * Infer the user's "home board" — the wall the home feed scopes to by default.
 *
 * Resolution priority:
 *   1. The explicit active board (the strongest signal: the user already picked
 *      a wall, and it survives cold start).
 *   2. The board type the user has logged the most ticks on, mapped to the owned
 *      board of that type with the most activity (the real gym wall, not a stale
 *      custom config). Tick history is keyed by board *type* only, so this maps
 *      type → owned board.
 *   3. The single owned board, when there's exactly one.
 *   4. Otherwise `null` (the caller falls back to the crew feed).
 *
 * Read-only: it never writes the active board. The active board stays the user's
 * explicit choice (it also drives BLE and the climb list); the home board is a
 * feed-scoping concept layered on top.
 */
export function useHomeBoard(): HomeBoardResult {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isLoading: activeBoardLoading } = useActiveBoard();
  const { data: myBoardsConn, isLoading: boardsLoading } = useMyBoards(undefined, { enabled: isAuthenticated });
  const { data: profile, isLoading: profileLoading } = useProfile({ enabled: isAuthenticated });

  const boards = myBoardsConn?.boards;
  // Only pay for the per-board-type tick scan when it can actually change the
  // answer: no active board AND more than one owned board to disambiguate.
  const needsTicks = !activeBoard && (boards?.length ?? 0) > 1;
  const { data: ticksByBoard, isLoading: ticksLoading } = useAllBoardsTicks(needsTicks ? profile?.id : undefined);

  const board = useMemo<UserBoard | null>(() => {
    if (activeBoard) return activeBoard;
    if (!boards || boards.length === 0) return null;
    if (boards.length === 1) return boards[0];

    if (ticksByBoard) {
      let topType: string | null = null;
      let topCount = 0;
      for (const [boardType, entries] of Object.entries(ticksByBoard)) {
        if (entries.length > topCount) {
          topCount = entries.length;
          topType = boardType;
        }
      }
      if (topType) {
        const candidates = boards.filter((candidate) => candidate.boardType === topType);
        if (candidates.length > 0) {
          return candidates.reduce((best, candidate) =>
            boardActivity(candidate) > boardActivity(best) ? candidate : best,
          );
        }
      }
    }

    return null;
  }, [activeBoard, boards, ticksByBoard]);

  // The active board is read from AsyncStorage, so it's `undefined` for the
  // first render(s). Treat that pending read as "still resolving" — otherwise a
  // warm `myBoards` cache hit could settle `isResolving` to false while the
  // stored board is still loading, and a one-shot caller would lock in the wrong
  // (inferred) board instead of the user's real active pick.
  // When `needsTicks`, the tick query is gated on `profile?.id`, so it stays
  // `isLoading: false` until the profile lands. Fold `profileLoading` into that
  // branch so a one-shot caller can't settle `isResolving` to false and lock in
  // the crew fallback before the tick-based inference has had its inputs.
  const isResolving =
    activeBoardLoading || (!activeBoard && (boardsLoading || (needsTicks && (profileLoading || ticksLoading))));
  return { board, boards: myBoardsConn?.boards ?? EMPTY_BOARDS, isResolving };
}
