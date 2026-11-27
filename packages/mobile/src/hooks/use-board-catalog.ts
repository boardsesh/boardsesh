import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useMemo } from 'react';
import { useIsBoardConfigVisible, useIsBoardTypeVisible } from './use-board-visibility';

/** Every catalogue board has a fixed shipped map; personal walls have their own flow. */
export function useAvailableCatalogBoards(): BoardName[] {
  const isBoardTypeVisible = useIsBoardTypeVisible();
  return useMemo(() => SUPPORTED_BOARDS.filter(isBoardTypeVisible), [isBoardTypeVisible]);
}

export function useBoardCatalogReadiness(boardName: BoardName, layoutId: number | null, sizeId: number | null) {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  return { geometryReady: isBoardConfigVisible({ boardName, layoutId, sizeId }) };
}
