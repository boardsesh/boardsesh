// The order the picker and onboarding list a climber's boards in, and which
// boards a list leaves out. Pure, so the rules are unit-testable without
// rendering. Which actions a card offers lives in `board-card-menu.ts`.

import type { UserBoard } from '@boardsesh/shared-schema';
import { boardIsOwnedBy } from './manage-items';

/**
 * Viewer-owned boards first, followed boards after, each group keeping its
 * incoming order.
 *
 * Used by onboarding only. The board picker deliberately does NOT use this any
 * more: `myBoards` now orders by pin, then by when you last opened the board
 * (#4884), and re-partitioning by ownership on top of that would file a pinned
 * gym board behind a wall you own and have never touched. Onboarding has no
 * usage history to order by, so ownership is still the best signal there.
 *
 * Returns the input order unchanged when there is no identity to compare
 * against, because guessing would file the user's own wall behind boards they
 * follow.
 */
export function sortViewerOwnedFirst(boards: readonly UserBoard[], currentUserId: string | undefined): UserBoard[] {
  if (currentUserId === undefined) return [...boards];
  const owned: UserBoard[] = [];
  const followed: UserBoard[] = [];
  for (const board of boards) {
    (boardIsOwnedBy(board, currentUserId) ? owned : followed).push(board);
  }
  return [...owned, ...followed];
}

/**
 * The boards not already shown higher up the picker, in the order given.
 *
 * The board you're on and its gym's walls sit at the top of the picker (At
 * {gym}, see picker-top-view.ts); Your boards and Near you leave out what the
 * top already lists, so a board shows once. The board you're on keeps its
 * place when the top does not list it: the server's order (pins, then last
 * opened, #4884) is the one the climber learned.
 */
export function withoutBoardsShown<Board extends { uuid: string }>(
  boards: readonly Board[],
  shownUuids: ReadonlySet<string>,
): Board[] {
  return shownUuids.size === 0 ? [...boards] : boards.filter((board) => !shownUuids.has(board.uuid));
}
