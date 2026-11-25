// "Use this board" on the gym-first screens (#8151): the climber takes a wall
// that already exists instead of adding a copy. Follow it unless it's already
// theirs, then bind it like any pick. Owner and privacy stay untouched.

import { useCallback } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useFollowBoard } from '../graphql/hooks';
import { useActivateBoard } from './use-activate-board';
import type { BoardReturnTo } from './board-return-to';
import { noteBoardFlowSecured } from './board-create-flow';
import { wallRelation } from './wall-candidates';

/**
 * Returns `take(board)`, which resolves `{ alreadyFollowed }` once the wall is
 * bound and the boards modal is on its way out, and rejects when the follow or
 * the bind failed, so the screen can say so inline (a toast draws behind the
 * boards modal). The follow comes first: a failed follow must never leave
 * active a wall that won't be in the climber's list tomorrow.
 */
export function useTakeExistingWall({
  returnTo,
  source,
  viewerId,
}: {
  returnTo: BoardReturnTo;
  /** The picker's `source`: `onboarding` closes out first run, as any first board does. */
  source: string | undefined;
  viewerId: string | null;
}) {
  const followBoard = useFollowBoard();
  const activate = useActivateBoard({
    source: source === 'onboarding' ? 'onboarding' : undefined,
    returnTo,
    writeFailure: 'rethrow',
  });
  const followWall = followBoard.mutateAsync;
  return useCallback(
    async (board: UserBoard): Promise<{ alreadyFollowed: boolean }> => {
      const alreadyFollowed = wallRelation(board, viewerId) !== null;
      if (!alreadyFollowed) await followWall(board);
      // Before the bind, whose navigation unmounts the flow's screens; undone
      // if the bind fails, so leaving afterwards still counts as a quit.
      const undoSecured = noteBoardFlowSecured();
      try {
        await activate(board, { pickSource: 'gym_finder' });
      } catch (error) {
        undoSecured();
        throw error;
      }
      return { alreadyFollowed };
    },
    [followWall, activate, viewerId],
  );
}
