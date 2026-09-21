// Pure decision for what "adopting" a board found in discovery entails. Kept
// renderer/hook-free so it can be unit-tested without the GraphQL/offline plumbing.

import type { UserBoard } from '@boardsesh/shared-schema';
import { boardIsOwnedBy } from '../../components/board-discovery/manage-items';

export type AdoptOfflineAction = 'auto' | 'ask' | 'none';

export type AdoptDecision = {
  /** Follow the board server-side so it lands in My Boards. */
  follow: boolean;
  /** What to do about offline availability. */
  offline: AdoptOfflineAction;
};

export type AdoptFoundBoardParams = {
  /**
   * The signed-in viewer created this board (`board.ownerId === viewerId`,
   * via `boardIsOwnedBy`). `undefined` while the viewer's id is unresolved.
   *
   * NOT `UserBoard.isOwned`. That is the creator's "I own this physical wall"
   * flag: the same for every viewer, and `true` by default for every board
   * built in the app. Reading it as "yours" meant a climber who picked a gym
   * or community board someone else built never followed it, so it was
   * missing from Your boards the next time they opened the picker (#5654).
   */
  isViewerOwner: boolean | undefined;
  /** Viewer already follows this board. */
  isFollowedByMe: boolean;
  /**
   * The board is private (`isPublic === false`). The server refuses to follow
   * someone else's private board, and a private board the viewer can see with
   * no id to check it against is almost always their own.
   */
  isPrivate: boolean;
  /** Native offline mode is available on this platform. */
  offlineEnabled: boolean;
  /** The user's "keep all boards offline by default" setting. */
  autoOffline: boolean;
  /** This board's scope is already in `syncEnabledBoards`. */
  alreadyEnabledOffline: boolean;
};

/** The ownership half of the decision: whose board this is, from the viewer's side. */
export type BoardOwnership = Pick<AdoptFoundBoardParams, 'isViewerOwner' | 'isFollowedByMe' | 'isPrivate'>;

/**
 * Read a board's ownership for `viewerId`. Compared against `ownerId` through
 * `boardIsOwnedBy`, never `board.isOwned` alone. `boardIsOwnedBy` only falls
 * back to `isOwned` for a persisted snapshot with no `ownerId`; everything the
 * server sends carries one.
 */
export function boardOwnershipForViewer(board: UserBoard, viewerId: string | undefined): BoardOwnership {
  return {
    isViewerOwner: viewerId === undefined ? undefined : boardIsOwnedBy(board, viewerId),
    isFollowedByMe: board.isFollowedByMe === true,
    isPrivate: board.isPublic === false,
  };
}

/**
 * The follow half on its own: follow unless the board is already the viewer's
 * (built by them or followed) or private. Shared by adoption, the pick event and
 * the active-board follow heal, so all three answer the same way.
 */
export function shouldFollowBoard({ isViewerOwner, isFollowedByMe, isPrivate }: BoardOwnership): boolean {
  return isViewerOwner !== true && !isFollowedByMe && !isPrivate;
}

/**
 * Decide what adopting a found board means: follow it when it isn't already the
 * viewer's (built by them or followed), and — when offline downloads are
 * available — either auto-download it (global default on), ask the user, or do
 * nothing.
 *
 * An unresolved viewer still follows a public board. The worst case is the
 * viewer following their own board, which is harmless: `followBoard` is
 * idempotent and `myBoards` is "owned OR followed", so it never lists twice.
 *
 * The offline offer only *asks* when we know the board is someone else's and new
 * to the viewer. Re-selecting a board you built or follow never nags, and neither
 * does an unresolved viewer; a global auto-offline default still silently
 * ensures any not-yet-enabled board gets downloaded.
 */
export function decideAdoptFoundBoard({
  isViewerOwner,
  isFollowedByMe,
  isPrivate,
  offlineEnabled,
  autoOffline,
  alreadyEnabledOffline,
}: AdoptFoundBoardParams): AdoptDecision {
  const alreadyTheirs = isViewerOwner === true || isFollowedByMe;
  const follow = shouldFollowBoard({ isViewerOwner, isFollowedByMe, isPrivate });

  if (!offlineEnabled || alreadyEnabledOffline) return { follow, offline: 'none' };
  if (autoOffline) return { follow, offline: 'auto' };
  return { follow, offline: !alreadyTheirs && isViewerOwner === false ? 'ask' : 'none' };
}
