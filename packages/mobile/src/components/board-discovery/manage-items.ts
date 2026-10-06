// Pure builder for the My Boards management list. Kept out of the screen so the
// owned/followed split (the trickiest bit) is unit-testable without rendering.

import type { UserBoard } from '@boardsesh/shared-schema';

/**
 * One of the climber's archived spray walls: the slice of `mySprayWalls` the
 * Archived section reads. `myBoards` leaves archived walls out, so they are not
 * `UserBoard` rows here.
 */
export type ArchivedSprayWallSummary = {
  uuid: string;
  name: string;
  /** ISO time the wall was archived. */
  archivedAt: string;
};

/** A row in the management list: a section header, a board, or an archived wall. */
export type ManageItem =
  | { type: 'header'; key: string; title: string }
  | { type: 'board'; key: string; board: UserBoard; isOwned: boolean; isActive: boolean }
  | { type: 'archivedWall'; key: string; wall: ArchivedSprayWallSummary; isActive: boolean };

/**
 * The archived walls in a `mySprayWalls` answer, most recently archived first.
 * Live walls (no `archivedAt`) and rows without a name are left out.
 */
export function archivedSprayWallSummaries(
  walls: readonly { uuid: string; archivedAt?: string | null; board?: { name?: string | null } | null }[] | undefined,
): ArchivedSprayWallSummary[] {
  if (!walls) return [];
  const archived: ArchivedSprayWallSummary[] = [];
  for (const wall of walls) {
    const name = wall.board?.name;
    if (wall.archivedAt && name) archived.push({ uuid: wall.uuid, name, archivedAt: wall.archivedAt });
  }
  // ISO 8601 strings in one zone sort as text.
  return archived.sort((left, right) =>
    left.archivedAt < right.archivedAt ? 1 : left.archivedAt > right.archivedAt ? -1 : 0,
  );
}

/**
 * Is this board the current user's own? `ownerId === currentUserId` whenever the
 * board carries an owner, which is always for anything the server sent
 * (`ownerId: ID!`).
 *
 * Persisted offline snapshots are the exception the fallback exists for: a card
 * written by a build that didn't capture `ownerId` still carries the server's own
 * `isOwned` answer from the moment it was downloaded, which beats filing the
 * user's home wall under "Following".
 */
export function boardIsOwnedBy(board: UserBoard, currentUserId: string | undefined): boolean {
  if (typeof board.ownerId === 'string' && board.ownerId.length > 0) return board.ownerId === currentUserId;
  return board.isOwned === true;
}

/**
 * Split `boards` (owned + followed, as `myBoards` returns them) into a flat item
 * array: an owned group then a followed group, each preceded by a header that's
 * omitted when the group is empty. Owned = `boardIsOwnedBy`.
 * The partition is this function's own: `myBoards` orders by pin and recency
 * (#4884), not owned-first, so the two groups are built here in a single pass.
 * Within each group the server's order is kept. The caller supplies the
 * localized header titles. Each board carries precomputed `isOwned`/`isActive`
 * so the row never scans for them.
 *
 * Archived walls come last, under their own header, so a wall a reset replaced
 * can still be opened to browse and log its climbs. Pass none to leave the
 * section out.
 */
export function buildManageItems(
  boards: readonly UserBoard[],
  currentUserId: string | undefined,
  activeUuid: string | undefined,
  labels: { ownedHeader: string; followingHeader: string; archivedHeader?: string },
  archivedWalls: readonly ArchivedSprayWallSummary[] = [],
): ManageItem[] {
  const items: ManageItem[] = [];
  const owned: UserBoard[] = [];
  const followed: UserBoard[] = [];
  for (const board of boards) {
    (boardIsOwnedBy(board, currentUserId) ? owned : followed).push(board);
  }
  if (owned.length > 0) {
    items.push({ type: 'header', key: 'header:owned', title: labels.ownedHeader });
    for (const board of owned) {
      items.push({ type: 'board', key: board.uuid, board, isOwned: true, isActive: board.uuid === activeUuid });
    }
  }
  if (followed.length > 0) {
    items.push({ type: 'header', key: 'header:following', title: labels.followingHeader });
    for (const board of followed) {
      items.push({ type: 'board', key: board.uuid, board, isOwned: false, isActive: board.uuid === activeUuid });
    }
  }
  if (archivedWalls.length > 0 && labels.archivedHeader) {
    items.push({ type: 'header', key: 'header:archived', title: labels.archivedHeader });
    for (const wall of archivedWalls) {
      // Keyed apart from the board rows: a wall the server has only just
      // archived can still be in a cached `myBoards` for a moment.
      items.push({ type: 'archivedWall', key: `archived:${wall.uuid}`, wall, isActive: wall.uuid === activeUuid });
    }
  }
  return items;
}
