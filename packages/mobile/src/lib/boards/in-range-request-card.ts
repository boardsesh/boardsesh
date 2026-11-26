// A friend's private home board heard over Bluetooth (the picker's In range
// slot). The serial lookup answers a board the climber can't open with its
// anonymous stub, and, signed in, a request card: whose board it is and
// nothing that finds it again (no place, slug or serial). The hero then reads
// "Sam's board is here" with Ask to climb, which opens the same sheet as the
// Friends' boards shelf (use-friend-board-action.tsx). Pure, so every match is
// a table row in the tests. A board the climber can open carries no card and
// draws exactly as before.

import type { FriendBoard, SerialBoardRequestCard, UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveryBoardItem } from '../../components/board-discovery/BoardDiscoveryCardView';
import { friendBoardSubtitle } from './friend-boards';

/** A board a heard serial matched, with the request card the lookup sent for it, if any. */
export type ObservedBoard = UserBoard & { requestCard?: SerialBoardRequestCard };

/** The request card a looked-up board carries, or null. Only an anonymous stub (empty uuid) ever carries one. */
export function requestCardOf(board: UserBoard): SerialBoardRequestCard | null {
  if (board.uuid || !('requestCard' in board)) return null;
  return (board as ObservedBoard).requestCard ?? null;
}

/** What the In range row offers: ask the owner, or (asked already) the waiting sheet. Null: a board as before. */
export type InRangeAskState = 'ask' | 'waiting';

/**
 * The card as the `FriendBoard` the ask sheet takes. The server never sends
 * the owner's id with a card, so it stays empty: the sheet only names them.
 */
export function friendBoardFromRequestCard(card: SerialBoardRequestCard): FriendBoard {
  return {
    viewerAccess: card.requested ? 'REQUESTED' : 'CAN_REQUEST',
    owner: { userId: '', displayName: card.ownerDisplayName, avatarUrl: card.ownerAvatarUrl },
    preview: card.preview,
    board: null,
  };
}

export type InRangeRequestCopy = {
  /** "{{name}}'s board is here". */
  titleNamed: (name: string) => string;
  /** For an owner with no name: "A climber's board is here". */
  titleUnnamed: string;
  /** The friend-board subtitle's word for an owner with no name (never shown: the owner is left out). */
  ownerFallback: string;
};

/**
 * The In range item for a board, with its request card applied: titled by its
 * owner, subtitled with what the board is and its angle, and Ask to climb (or
 * Requested) on its button. The item is returned unchanged for any board
 * without a card.
 */
export function withInRangeRequestCard(
  item: DiscoveryBoardItem,
  board: UserBoard,
  copy: InRangeRequestCopy,
): DiscoveryBoardItem {
  const card = requestCardOf(board);
  if (!card) return item;
  const ownerName = card.ownerDisplayName?.trim();
  return {
    ...item,
    title: ownerName ? copy.titleNamed(ownerName) : copy.titleUnnamed,
    subtitle: friendBoardSubtitle(friendBoardFromRequestCard(card), {
      includeOwner: false,
      ownerFallback: copy.ownerFallback,
    }),
    askToClimb: (card.requested ? 'waiting' : 'ask') satisfies InRangeAskState,
  };
}
