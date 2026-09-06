// Maps the various board shapes (saved UserBoard, popular config) onto the
// single DiscoveryBoardItem the carousel renders. Keeps the screen free of
// per-shape branching.

import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName, normaliseSetIds } from '@boardsesh/board-config';
import type { DiscoveryBoardItem } from './BoardDiscoveryCard';
import { boardTypeLabel } from './board-builder-labels';
import { boardRowSubtitle, disambiguateBoardSubtitles } from './board-labels';
import { boardIsOwnedBy } from './manage-items';
import type { BoardDownloadState } from './board-offline-state';

export function userBoardToItem(
  board: UserBoard,
  activeUuid?: string | null,
  /**
   * Whether this board's catalog is on the device. Only owned/followed boards
   * get one — a popular config has no `uuid`, so `rememberOfflineBoards` drops
   * it (see settings/offline-boards.ts) and it could never appear in the offline
   * picker even though its data would download.
   */
  offlineState?: BoardDownloadState,
  /**
   * The signed-in user's id, when the host has one. Resolving ownership here —
   * once per list build — is what keeps the card's action slot off a
   * `myBoards.find` inside a virtualized row. Omitted (and therefore
   * `isViewerOwner: undefined`) on Near you, where every board belongs to
   * someone else, and wherever no identity resolved: an undefined flag means
   * "we don't know", which the card renders as no action slot at all rather
   * than offering to unfollow the user's own wall.
   */
  currentUserId?: string,
  /**
   * Whether this board is pinned, when the caller has an optimistic override for
   * it. Defaults to the server's `isPinnedByMe`; the picker passes an override
   * so a just-tapped pin flips instantly without waiting for a refetch.
   */
  isPinnedOverride?: boolean,
): DiscoveryBoardItem | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  return {
    key: board.uuid,
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    title: board.name,
    subtitle: boardRowSubtitle(board),
    distanceMeters: board.distanceMeters ?? undefined,
    isActive: activeUuid != null && board.uuid === activeUuid,
    isViewerOwner: currentUserId === undefined ? undefined : boardIsOwnedBy(board, currentUserId),
    isPinned: isPinnedOverride ?? board.isPinnedByMe ?? false,
    offlineState,
  };
}

/**
 * The whole carousel's items in one pass, with same-subtitle boards pulled apart
 * (see `disambiguateBoardSubtitles`). Disambiguation is scoped to the one list
 * the user is looking at, and runs here — at the list level — never per row.
 */
export function userBoardsToItems(
  boards: UserBoard[],
  activeUuid?: string | null,
  offlineStateFor?: (board: UserBoard) => BoardDownloadState,
  currentUserId?: string,
  /** Uuids the user just toggled, pending the next fetch. See `userBoardToItem`. */
  pinnedOverrides?: ReadonlyMap<string, boolean>,
): DiscoveryBoardItem[] {
  // Only boards that actually render take part: a board dropped for an
  // unsupported type must not push its neighbour into a disambiguation the user
  // can see no reason for.
  const rendered: { item: DiscoveryBoardItem; board: UserBoard }[] = [];
  for (const board of boards) {
    const item = userBoardToItem(
      board,
      activeUuid,
      offlineStateFor?.(board),
      currentUserId,
      pinnedOverrides?.get(board.uuid),
    );
    if (item !== null) rendered.push({ item, board });
  }
  const subtitles = disambiguateBoardSubtitles(rendered.map((entry) => entry.board));
  return rendered.map((entry, index) => ({ ...entry.item, subtitle: subtitles[index] }));
}

export function popularConfigToItem(config: PopularBoardConfig): DiscoveryBoardItem | null {
  const boardName = toBoardName(config.boardType);
  if (boardName === null) return null;
  return {
    // Configs have no uuid — key on the config tuple.
    key: `popular:${config.boardType}:${config.layoutId}:${config.sizeId}:${config.setIds.join('-')}`,
    boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds.join(','),
    title: config.displayName,
    subtitle: config.sizeName ?? config.layoutName ?? boardTypeLabel(config.boardType),
  };
}

/** A board config (the create/popular tuple), used to find an owned match. */
export type BoardConfigKey = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids, as stored on UserBoard. */
  setIds: string;
};

/**
 * The board the user already owns that exactly matches `config`, if any. Used to
 * activate an existing board instead of hitting the server's duplicate-config
 * guard when a popular/custom config the user already has is selected.
 */
export function findOwnedBoardForConfig(boards: UserBoard[], config: BoardConfigKey): UserBoard | undefined {
  // Compare set ids order/format-insensitively: '24,25,26,27' and '25,26,27,24'
  // are the same physical board. Re-ticking a set in the builder re-appends it
  // at the end of the array, so the wire order can diverge from the stored
  // order even for the user's own board. Without normalising, the match misses,
  // CREATE_BOARD fires, and the server inserts a near-duplicate UserBoard.
  const configSetIds = normaliseSetIds(config.setIds);
  return boards.find(
    (b) =>
      b.boardType === config.boardType &&
      b.layoutId === config.layoutId &&
      b.sizeId === config.sizeId &&
      normaliseSetIds(b.setIds) === configSetIds,
  );
}
