// A board whose setup changed while the climber watched: a "Set up wrong"
// suggestion that applied, "Use this setup" on the review sheet, or an Undo on
// the climber-change notice (docs/product/directory-reports.md, "Suggested
// setup"). Each answers with the board as it now is, so this writes that board
// where the app reads it instead of waiting for a refetch.
//
// The active board matters most. It is a denormalised AsyncStorage copy with
// `staleTime: Infinity` (use-active-board.ts), so without this the climb list
// would keep the old layout until the self-heal re-reads it on the next
// foreground. Writing it here re-keys the list straight away.

import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useActiveBoard, useSetActiveBoard } from '../graphql/use-active-board';
import { GYM_BOARDS_QUERY_KEY } from '../graphql/query-keys';

/**
 * The board to store as active. On a board that tilts, the angle the climber
 * set on the wall is theirs, not the board's (the self-heal keeps it the same
 * way), so it stays. On a board that doesn't tilt, the angle is part of the
 * setup and the new one wins.
 */
export function boardKeepingLocalAngle(board: UserBoard, active: UserBoard | null | undefined): UserBoard {
  if (!active || active.uuid !== board.uuid || !board.isAngleAdjustable) return board;
  return { ...board, angle: active.angle };
}

/**
 * Returns a writer for a board that changed: the single-board read takes it
 * as is, the lists that show its setup re-read, and, when it is the active
 * board, the active copy takes the new setup. Resolves once the active board
 * is stored, so a caller that activates it next writes after this one.
 */
export function useApplyChangedBoard(): (board: UserBoard) => Promise<void> {
  const queryClient = useQueryClient();
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  // Read at call time: the caller usually holds this callback across an await.
  const activeBoardRef = useRef(activeBoard ?? null);
  activeBoardRef.current = activeBoard ?? null;

  return useCallback(
    async (board: UserBoard) => {
      queryClient.setQueryData(['board', board.uuid], { board });
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['searchBoards'] });
      void queryClient.invalidateQueries({ queryKey: GYM_BOARDS_QUERY_KEY });
      const active = activeBoardRef.current;
      if (active?.uuid === board.uuid) await setActiveBoard(boardKeepingLocalAngle(board, active));
    },
    [queryClient, setActiveBoard],
  );
}
