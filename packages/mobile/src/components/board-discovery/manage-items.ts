// Pure builder for the My Boards management list. Kept out of the screen so the
// owned/followed split (the trickiest bit) is unit-testable without rendering.

import type { UserBoard } from '@boardsesh/shared-schema';

/** A row in the management list: a section header or a board. */
export type ManageItem =
  | { type: 'header'; key: string; title: string }
  | { type: 'board'; key: string; board: UserBoard; isOwned: boolean; isActive: boolean };

/**
 * Split `boards` (owned + followed, as `myBoards` returns them) into a flat item
 * array: an owned group then a followed group, each preceded by a header that's
 * omitted when the group is empty. Owned = `board.ownerId === currentUserId`.
 * `myBoards` already orders owned-first, so this is a single pass; the caller
 * supplies the localized header titles. Each board carries precomputed
 * `isOwned`/`isActive` so the row never scans for them.
 */
export function buildManageItems(
  boards: UserBoard[],
  currentUserId: string | undefined,
  activeUuid: string | undefined,
  labels: { ownedHeader: string; followingHeader: string },
): ManageItem[] {
  const items: ManageItem[] = [];
  const owned = boards.filter((board) => board.ownerId === currentUserId);
  const followed = boards.filter((board) => board.ownerId !== currentUserId);
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
