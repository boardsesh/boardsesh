// A gym's boards as the gym page's rows draw them. Pure, so the menu rules a
// row inherits (which boards offer "Remove from your boards", what a row is
// called) are a table in the tests.

import { stripGymNamePrefix, type BoardLabelOptions } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveryBoardItem } from '../board-discovery/BoardDiscoveryCardView';
import { userBoardsToItems } from '../board-discovery/board-items';

export type GymBoardItemsOptions = {
  gymName: string;
  /** The board the climber is on, marked in the list as the picker marks it. */
  activeUuid?: string | null;
  /** The signed-in climber, when known. Without it no row offers to manage anything it can't prove is theirs. */
  viewerId?: string;
  /** The `within-gym` scope, so a subtitle leads with the wall rather than the gym the page already names. */
  labelOptions?: BoardLabelOptions;
};

/**
 * One item per board, in the server's order (name, then age), titled without
 * the gym's name in front ("Crux - Kilter" reads "Kilter" under Crux's heading,
 * as on the website).
 *
 * The gym's roster is everyone's boards, not the climber's list, so ownership
 * means three things here: the climber's own (`true`), one they saved
 * (`false`, which offers "Remove from your boards"), or someone else's they
 * never saved (`undefined`, which offers nothing of the kind). Edit, Remove from
 * gym and Delete still follow the server's flags on every row.
 */
export function gymBoardsToItems(boards: UserBoard[], options: GymBoardItemsOptions): DiscoveryBoardItem[] {
  const { gymName, activeUuid, viewerId, labelOptions } = options;
  const followedUuids = new Set(boards.filter((board) => board.isFollowedByMe === true).map((board) => board.uuid));
  return userBoardsToItems(boards, { activeUuid, currentUserId: viewerId, labelOptions }).map((item) => ({
    ...item,
    title: stripGymNamePrefix(item.title, gymName),
    isViewerOwner: item.isViewerOwner === false && !followedUuids.has(item.key) ? undefined : item.isViewerOwner,
    // Pins and downloads live in the climber's own list; the gym page draws neither.
    isPinned: false,
    offlineState: undefined,
    gymName: item.gymName ?? gymName,
  }));
}
