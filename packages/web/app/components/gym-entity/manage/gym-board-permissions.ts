// Pure permission helpers for the manage-gym Boards tab. Only linking your own
// board is decided here, mirroring the backend linkBoardToGym staff path: the
// viewer owns the board (`board.ownerId === userId`) and is the gym's owner or
// an admin. Remove from gym and Delete are the server's call, read off each
// board (`UserBoard.canRemoveFromGym`, `UserBoard.canDelete`), so no client
// rebuilds those rules.

import type { Gym, UserBoard } from '@boardsesh/shared-schema';

/** True when the viewer may link boards to this gym (gym owner or gym admin). */
export function canManageGymBoards(gym: Pick<Gym, 'ownerId' | 'myRole'>, viewerUserId: string | null): boolean {
  if (!viewerUserId) return false;
  return gym.ownerId === viewerUserId || gym.myRole === 'admin';
}

/**
 * Boards from the viewer's myBoards list that can be offered in the "Add a
 * board" dialog: owned by the viewer (myBoards also contains followed boards),
 * and not already on this gym.
 */
export function linkableBoards<BoardShape extends Pick<UserBoard, 'uuid' | 'ownerId' | 'gymUuid'>>(
  myBoards: readonly BoardShape[],
  gymUuid: string,
  linkedBoardUuids: ReadonlySet<string>,
  viewerUserId: string | null,
): BoardShape[] {
  if (!viewerUserId) return [];
  return myBoards.filter(
    (board) => board.ownerId === viewerUserId && board.gymUuid !== gymUuid && !linkedBoardUuids.has(board.uuid),
  );
}
