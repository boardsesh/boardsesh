// The order the picker and onboarding list a climber's boards in. Pure, so the
// ordering rules are unit-testable without rendering. Which actions a card
// offers lives in `board-card-menu.ts`.

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
 * The active board first, everything else in the order the server gave.
 *
 * The server cannot do this itself: the active board lives in AsyncStorage on
 * the device, so `myBoards` has never heard of it. Hoist-only — a board that is
 * not in the list is never injected, so a stale stored board cannot conjure a
 * card. Mirrors what the offline branch already does in `offline-board-items`.
 */
export function hoistActiveBoard(boards: readonly UserBoard[], activeUuid: string | null | undefined): UserBoard[] {
  if (activeUuid == null) return [...boards];
  const active = boards.find((board) => board.uuid === activeUuid);
  if (!active) return [...boards];
  return [active, ...boards.filter((board) => board.uuid !== activeUuid)];
}
