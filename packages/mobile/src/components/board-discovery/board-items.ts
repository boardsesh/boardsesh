// Maps the various board shapes (saved UserBoard, popular config) onto the
// single DiscoveryBoardItem the carousel renders. Keeps the screen free of
// per-shape branching.

import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName, normaliseSetIds } from '@boardsesh/board-config';
import { createGuestActiveBoard } from '../../lib/boards/guest-board';
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

export function popularConfigToItem(
  config: PopularBoardConfig,
  activeBoard?: UserBoard | null,
): DiscoveryBoardItem | null {
  const boardName = toBoardName(config.boardType);
  if (boardName === null) return null;
  const setIds = config.setIds.join(',');
  return {
    // Configs have no uuid — key on the config tuple.
    key: `popular:${config.boardType}:${config.layoutId}:${config.sizeId}:${config.setIds.join('-')}`,
    boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds,
    title: config.displayName,
    subtitle: config.sizeName ?? config.layoutName ?? config.boardType,
    isActive:
      activeBoard != null &&
      boardMatchesConfig(activeBoard, {
        boardType: config.boardType,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds,
      }),
  };
}

export function popularItemToGuestBoard(item: DiscoveryBoardItem): UserBoard {
  return createGuestActiveBoard({
    boardName: item.boardName,
    layoutId: item.layoutId,
    sizeId: item.sizeId,
    setIds: item.setIds,
    displayName: item.title,
    sizeName: item.subtitle,
  });
}

/** A board config (the create/popular tuple), used to find an owned match. */
export type BoardConfigKey = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids, as stored on UserBoard. */
  setIds: string;
};

function boardMatchesConfig(board: UserBoard, config: BoardConfigKey): boolean {
  return (
    board.boardType === config.boardType &&
    board.layoutId === config.layoutId &&
    board.sizeId === config.sizeId &&
    normaliseSetIds(board.setIds) === normaliseSetIds(config.setIds)
  );
}

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
  return boards.find((b) => boardMatchesConfig(b, { ...config, setIds: configSetIds }));
}
