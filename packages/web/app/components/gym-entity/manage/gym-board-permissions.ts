// Pure permission helpers for the manage-gym Boards tab, mirroring the backend
// linkBoardToGym contract: BOTH link and unlink require the viewer to own the
// board (`board.ownerId === userId`), and linking additionally requires the
// viewer to be the gym's owner or an admin (requireGymOwnerOrAdmin). Gym
// editors can open the tab (canEdit), but gym membership alone does not grant
// deletion. Deleting requires board ownership or ownership/admin of its gym.

import type { Gym, UserBoard } from '@boardsesh/shared-schema';

/** True when the viewer may link boards to this gym (gym owner or gym admin). */
export function canManageGymBoards(gym: Pick<Gym, 'ownerId' | 'myRole'>, viewerUserId: string | null): boolean {
  if (!viewerUserId) return false;
  return gym.ownerId === viewerUserId || gym.myRole === 'admin';
}

/** True when the viewer may unlink this board (they own the board itself). */
export function canUnlinkBoard(board: Pick<UserBoard, 'ownerId'>, viewerUserId: string | null): boolean {
  return !!viewerUserId && board.ownerId === viewerUserId;
}

/**
 * Only call for readable boards returned by gymBoards, which scopes them to
 * this gym. Location privacy may redact gymUuid even for its administrators;
 * the backend checks the current, unprojected association before deletion.
 */
export function canDeleteGymBoard(
  board: Pick<UserBoard, 'ownerId' | 'gymUuid'>,
  gym: Pick<Gym, 'uuid' | 'ownerId' | 'myRole'>,
  viewerUserId: string | null,
): boolean {
  if (!viewerUserId) return false;
  return (
    board.ownerId === viewerUserId ||
    ((board.gymUuid == null || board.gymUuid === gym.uuid) && canManageGymBoards(gym, viewerUserId))
  );
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
