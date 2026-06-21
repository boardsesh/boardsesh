// Maps the various board shapes (saved UserBoard, popular config) onto the
// single DiscoveryBoardItem the carousel renders. Keeps the screen free of
// per-shape branching.

import type { BoardName, UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName, normaliseSetIds } from '@boardsesh/board-config';
import type { DiscoveryBoardItem } from './BoardDiscoveryCard';

export function userBoardToItem(board: UserBoard, activeUuid?: string | null): DiscoveryBoardItem | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  return {
    key: board.uuid,
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    title: board.name,
    subtitle: board.sizeName ?? board.boardType,
    distanceMeters: board.distanceMeters ?? undefined,
    isActive: activeUuid != null && board.uuid === activeUuid,
  };
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
    subtitle: config.sizeName ?? config.layoutName ?? config.boardType,
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
