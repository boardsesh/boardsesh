// Which secondary action a board card offers, and the viewer-owned-first order
// the picker shows them in. Pure, so the branch that decides between "delete this
// wall forever" and "stop following this gym" is unit-testable without rendering.

import type { UserBoard } from '@boardsesh/shared-schema';
import { boardIsOwnedBy } from './manage-items';

/**
 * The card's single action slot. There is deliberately no `'follow'` member:
 * `myBoards` returns boards the viewer owns OR follows, so inside that list a
 * non-owned board is always one you already follow. Following someone else's
 * board happens on Near you / the gym finder, not here.
 */
export type BoardCardAction = 'edit' | 'unfollow' | 'delete' | null;

export type BoardCardActionInput = {
  /**
   * Whether the viewer owns this board. Stamped once per list build by
   * `userBoardToItem`; `false` covers both "followed" and "we could not resolve
   * an identity", which is why `readOnly` and the screen's Edit gate carry the
   * degraded case instead.
   */
  isViewerOwner: boolean;
  /** The "Your boards" section is in Edit mode. */
  isEditing: boolean;
  /** No usable connection: every action here is a server mutation. */
  readOnly: boolean;
};

export function boardCardAction({ isViewerOwner, isEditing, readOnly }: BoardCardActionInput): BoardCardAction {
  if (readOnly) return null;
  // Delete is owner-only server-side, so a followed board's Edit-mode control
  // stays an unfollow rather than a delete the backend would reject.
  if (isEditing) return isViewerOwner ? 'delete' : 'unfollow';
  return isViewerOwner ? 'edit' : 'unfollow';
}

/**
 * Viewer-owned boards first, followed boards after, each group keeping its
 * incoming order.
 *
 * The server orders `myBoards` by `desc(userBoards.isOwned)`, but that column
 * means "a real user-owned wall", not "owned by the viewer" — so a gym board the
 * viewer merely follows can lead the carousel. Returns the input order unchanged
 * when there is no identity to compare against, because guessing would file the
 * user's own wall behind boards they follow.
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
