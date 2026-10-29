// Which board at the climber's gym draws a given climb.
//
// Two callers ask this: the play drawer's Switch board button and the bulb's
// connect (#7001). They must give the same answer. If they didn't, Connect would
// take the climber to one board while the Switch board button named another.

import type { UserBoard } from '@boardsesh/shared-schema';
import { boardLooselyMatches } from './board-matches';

/** A climb's board model as the queue carries it. */
export type ClimbBoardModel = { boardType?: string | null; layoutId?: number | null };

/**
 * The board at the active board's gym that is the climb's board model (board
 * name + layout), or null. The active board itself never counts: switching to
 * the board the climber is already on would change nothing.
 *
 * Two boards of one model at a gym can't be told apart from a climb, so the
 * first one in the roster wins.
 */
export function findGymBoardForClimb(
  climbBoard: { boardName: string; layoutId?: number | null },
  activeBoardUuid: string | null | undefined,
  gymBoards: ReadonlyArray<UserBoard> | null | undefined,
): UserBoard | null {
  if (!gymBoards) return null;
  return (
    gymBoards.find(
      (board) =>
        board.uuid !== activeBoardUuid &&
        boardLooselyMatches({ boardName: board.boardType, layoutId: board.layoutId }, climbBoard),
    ) ?? null
  );
}

/**
 * The gym board to connect to instead of the active one, or null when the
 * active board is the right one.
 *
 * Only a different board MODEL moves the connect: a MoonBoard climb while a
 * Kilter is active. A climb of the same model on a bigger wall stays on the
 * active board, which is what the player's Switch board gate does too. A climb
 * with no board name says nothing, so it stays on the active board as well.
 */
export function findGymBoardToConnectForClimb(
  climb: ClimbBoardModel | null | undefined,
  activeBoard: Pick<UserBoard, 'uuid' | 'boardType' | 'layoutId'> | null | undefined,
  gymBoards: ReadonlyArray<UserBoard> | null | undefined,
): UserBoard | null {
  if (!climb?.boardType || !activeBoard) return null;
  const climbBoard = { boardName: climb.boardType, layoutId: climb.layoutId };
  if (boardLooselyMatches({ boardName: activeBoard.boardType, layoutId: activeBoard.layoutId }, climbBoard)) {
    return null;
  }
  return findGymBoardForClimb(climbBoard, activeBoard.uuid, gymBoards);
}
