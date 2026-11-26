// "A friend's board" (friendsBoards: the boards of people who follow the
// viewer): the rows the picker's Friends' boards shelf and the wizard's "Whose
// board?" step draw, and the rules behind them. Pure, so the shelf's dedupe and
// cap, the owner grouping and the empty states are tables in tests.

import { boardConfigLabel, formatBoardDisplayName, toBoardName } from '@boardsesh/board-config';
import type { FriendBoard, FriendBoardOwner } from '@boardsesh/shared-schema';
import type { DiscoveryBoardItem } from '../../components/board-discovery/BoardDiscoveryCardView';
import type { GroupedCellPosition } from '../../components/gym-page/gym-page-view-model';

/** Rows the picker's Friends' boards shelf shows; "See all" opens the rest. */
export const FRIENDS_SHELF_MAX_ROWS = 5;

/** The owner's name, or the catalogue's word for someone with none. */
export function friendBoardOwnerName(owner: FriendBoardOwner, fallback: string): string {
  const name = owner.displayName?.trim();
  return name ? name : fallback;
}

/**
 * The subtitle: the owner (where no header names them), what the board is,
 * and its angle. "Sam · Kilter Original 12×12 · 40°".
 */
export function friendBoardSubtitle(
  friendBoard: FriendBoard,
  { includeOwner, ownerFallback }: { includeOwner: boolean; ownerFallback: string },
): string {
  const { preview } = friendBoard;
  const config = boardConfigLabel(preview);
  const brand = formatBoardDisplayName(preview.boardType);
  const parts = [
    includeOwner ? friendBoardOwnerName(friendBoard.owner, ownerFallback) : null,
    config ? `${brand} ${config}` : brand,
    `${preview.angle}°`,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

export type FriendBoardRowCopy = {
  /** What to call an owner with no name. */
  ownerFallback: string;
  /** The pill on a row whose request waits ("Requested"). */
  requested: string;
};

/**
 * One friend's board as the row `BoardRow` draws. The art comes from the
 * preview, so a board the viewer can't open yet still shows what it is. A
 * request row carries the lock (`accessLocked`); a waiting one the Requested
 * pill. No menu, pin or download state: none of that is the viewer's yet.
 */
export function friendBoardToItem(
  friendBoard: FriendBoard,
  { includeOwner, copy, activeUuid }: { includeOwner: boolean; copy: FriendBoardRowCopy; activeUuid?: string | null },
): DiscoveryBoardItem | null {
  const { preview, viewerAccess } = friendBoard;
  const boardName = toBoardName(preview.boardType);
  if (boardName === null) return null;
  return {
    key: preview.uuid,
    boardName,
    layoutId: preview.layoutId,
    sizeId: preview.sizeId,
    setIds: preview.setIds,
    title: preview.name,
    subtitle: friendBoardSubtitle(friendBoard, { includeOwner, ownerFallback: copy.ownerFallback }),
    isActive: activeUuid != null && preview.uuid === activeUuid,
    accessLocked: viewerAccess === 'CAN_REQUEST',
    badge: viewerAccess === 'REQUESTED' ? copy.requested : null,
  };
}

/**
 * The picker's shelf: boards already in Your boards are left out (a refetch of
 * one list can land before the other's), duplicates go, and at most `max` stay.
 */
export function friendsShelfBoards(
  friendBoards: readonly FriendBoard[],
  yourBoardUuids: ReadonlySet<string>,
  max: number = FRIENDS_SHELF_MAX_ROWS,
): FriendBoard[] {
  const seen = new Set<string>();
  const shelf: FriendBoard[] = [];
  for (const friendBoard of friendBoards) {
    const uuid = friendBoard.preview.uuid;
    if (yourBoardUuids.has(uuid) || seen.has(uuid)) continue;
    seen.add(uuid);
    shelf.push(friendBoard);
    if (shelf.length >= max) break;
  }
  return shelf;
}

/** One cell of "Whose board?": an owner's header, or one of their boards as a slice of the owner's card. */
export type FriendBoardListCell =
  | { kind: 'owner'; key: string; owner: FriendBoardOwner; name: string }
  | {
      kind: 'board';
      key: string;
      friendBoard: FriendBoard;
      item: DiscoveryBoardItem;
      position: GroupedCellPosition;
    };

function cellPosition(index: number, count: number): GroupedCellPosition {
  if (count <= 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

/**
 * The flat cell list for the virtualized "Whose board?": boards grouped under
 * their owner, owners in the order the server first lists them (the boards the
 * viewer climbs on first), each owner's boards in server order. Duplicates
 * across pages are dropped.
 */
export function friendBoardListCells(
  friendBoards: readonly FriendBoard[],
  { copy, activeUuid }: { copy: FriendBoardRowCopy; activeUuid?: string | null },
): FriendBoardListCell[] {
  const groups = new Map<
    string,
    { owner: FriendBoardOwner; boards: { friendBoard: FriendBoard; item: DiscoveryBoardItem }[] }
  >();
  const seen = new Set<string>();
  for (const friendBoard of friendBoards) {
    const uuid = friendBoard.preview.uuid;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const item = friendBoardToItem(friendBoard, { includeOwner: false, copy, activeUuid });
    if (item === null) continue;
    const ownerId = friendBoard.owner.userId;
    let group = groups.get(ownerId);
    if (!group) {
      group = { owner: friendBoard.owner, boards: [] };
      groups.set(ownerId, group);
    }
    group.boards.push({ friendBoard, item });
  }
  const cells: FriendBoardListCell[] = [];
  for (const [ownerId, group] of groups) {
    cells.push({
      kind: 'owner',
      key: `owner:${ownerId}`,
      owner: group.owner,
      name: friendBoardOwnerName(group.owner, copy.ownerFallback),
    });
    group.boards.forEach(({ friendBoard, item }, index) => {
      cells.push({
        kind: 'board',
        key: `board:${item.key}`,
        friendBoard,
        item,
        position: cellPosition(index, group.boards.length),
      });
    });
  }
  return cells;
}

/** Which placard "Whose board?" shows instead of a list, or null for the list. */
export type FriendBoardsEmptyKind = 'offline' | 'no_followers' | 'no_boards' | 'no_match';

/**
 * The list holds boards of people who follow the viewer, so "nobody follows
 * you" is its own placard: the fix is for a friend to follow them.
 */
export function friendBoardsEmptyKind({
  offline,
  query,
  followerCount,
  boardCount,
}: {
  /** The list can't load for want of a connection (and nothing is on screen). */
  offline: boolean;
  /** The trimmed search. */
  query: string;
  /** How many people follow the viewer, when known. */
  followerCount: number | null | undefined;
  boardCount: number;
}): FriendBoardsEmptyKind | null {
  if (boardCount > 0) return null;
  if (offline) return 'offline';
  if (query.length > 0) return 'no_match';
  return followerCount === 0 ? 'no_followers' : 'no_boards';
}
