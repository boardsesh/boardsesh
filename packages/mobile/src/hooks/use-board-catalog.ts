import { SUPPORTED_BOARDS, getQuantumModelForConfig } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';

/** Every catalogue board has a fixed shipped map; personal walls have their own flow. */
export function useAvailableCatalogBoards(): BoardName[] {
  return SUPPORTED_BOARDS;
}

const fixedSetupChecks: Partial<Record<BoardName, (layoutId: number, sizeId: number) => boolean>> = {
  quantum: (layoutId, sizeId) => getQuantumModelForConfig(layoutId, sizeId) !== null,
};

export function useBoardCatalogReadiness(boardName: BoardName, layoutId: number | null, sizeId: number | null) {
  return {
    geometryReady: fixedSetupChecks[boardName]
      ? layoutId != null && sizeId != null && fixedSetupChecks[boardName]!(layoutId, sizeId)
      : true,
  };
}
