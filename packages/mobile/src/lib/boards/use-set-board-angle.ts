// The one place a board's angle is written.
//
// Before this, every angle control did the same thing inline —
// `setActiveBoard({ ...activeBoard, angle })` — from four call sites (the Climbs
// toolbar, the Material angle control, the play drawer, and the inbound party
// board-path follower). That spread the rule "a fixed-angle wall never moves"
// across four files and left the angle recorded only on whichever board happened
// to be active, so it was lost the moment you switched away.
//
// Routing them all through here does two things: the angle is remembered per
// board (see `board-angle-store.ts`), and there is a single seam for making the
// angle authoritative. When `setBoardAngle` exists server-side and broadcasts
// over the board-presence socket, the optimistic write and the subscription echo
// both land in this hook and nothing else has to change.

import { useCallback } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useActiveBoard, useSetActiveBoard } from '../graphql/use-active-board';
import { setStoredBoardAngle } from './board-angle-store';
import { reportError } from '../error-reporting';

/**
 * Returns `setBoardAngle(board, angle)`. Persists the angle against the board,
 * and re-binds the active board when the board being adjusted is the active one
 * — which re-grades the climb list (its search key carries the angle) and wakes
 * the queue re-grade effect, exactly as the inline writes used to.
 *
 * A fixed-angle wall is ignored rather than rejected: the angle controls are
 * already hidden for those boards, so reaching here means a stale render, not a
 * climber decision worth an error.
 */
export function useSetBoardAngle() {
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();

  return useCallback(
    async (board: UserBoard, angle: number): Promise<void> => {
      if (board.isAngleAdjustable === false) return;
      if (angle === board.angle && board.uuid !== activeBoard?.uuid) return;

      // Reserve the active-board intent before storage can yield. Otherwise a
      // delayed angle write can restore this board after the climber picks
      // another one. Even a return to the rendered angle is a newer intent:
      // an earlier angle change may still be queued without a new render yet.
      const activeBoardWrite =
        activeBoard && board.uuid === activeBoard.uuid ? setActiveBoard({ ...activeBoard, angle }) : Promise.resolve();

      // Keep the remembered angle independent of active-board persistence, so
      // either write can succeed when the other fails. Attach both handlers
      // immediately while the active-board coordinator preserves intent order.
      await Promise.all([
        activeBoardWrite,
        setStoredBoardAngle(board.uuid, angle).catch((error: unknown) => {
          reportError(error);
        }),
      ]);
    },
    [activeBoard, setActiveBoard],
  );
}
