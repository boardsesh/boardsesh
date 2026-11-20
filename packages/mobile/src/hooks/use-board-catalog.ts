import { SUPPORTED_BOARDS, getQuantumModelForConfig } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useMemo } from 'react';
import { useIsBoardTypeVisible } from './use-board-visibility';

/** Every catalogue board has a fixed shipped map; personal walls have their own flow. */
export function useAvailableCatalogBoards(): BoardName[] {
  const isBoardTypeVisible = useIsBoardTypeVisible();
  return useMemo(() => SUPPORTED_BOARDS.filter(isBoardTypeVisible), [isBoardTypeVisible]);
}

const fixedSetupChecks: Partial<Record<BoardName, (layoutId: number, sizeId: number) => boolean>> = {
  quantum: (layoutId, sizeId) => getQuantumModelForConfig(layoutId, sizeId) !== null,
};

export function useBoardCatalogReadiness(boardName: BoardName, layoutId: number | null, sizeId: number | null) {
  const isBoardTypeVisible = useIsBoardTypeVisible();
  return {
    geometryReady:
      isBoardTypeVisible(boardName) &&
      (fixedSetupChecks[boardName]
        ? layoutId != null && sizeId != null && fixedSetupChecks[boardName]!(layoutId, sizeId)
        : true),
  };
}
