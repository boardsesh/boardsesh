// Pure builder for the My Boards management list. Kept out of the screen so the
// owned/followed split (the trickiest bit) is unit-testable without rendering.

import type { UserBoard } from '@boardsesh/shared-schema';

/** A row in the management list: a section header or a board. */
export type ManageItem =
  | { type: 'header'; key: string; title: string }
  | { type: 'board'; key: string; board: UserBoard; isOwned: boolean; isActive: boolean };

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
 */
export function buildManageItems(
  boards: readonly UserBoard[],
  currentUserId: string | undefined,
  activeUuid: string | undefined,
  labels: { ownedHeader: string; followingHeader: string },
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
  return items;
}
