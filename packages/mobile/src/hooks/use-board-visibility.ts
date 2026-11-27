import { useCallback } from 'react';
import {
  isBoardConfigVisible,
  isBoardTypeVisible,
  QUANTUM_BOARD_FLAG,
  type BoardVisibilityConfig,
} from '@boardsesh/board-config/visibility';
import { useFeatureFlag } from '../providers/feature-flags-provider';

/** Rollout policy belongs at the catalogue boundary, never in board rows or renderers. */
export function useIsBoardTypeVisible() {
  const quantumEnabled = useFeatureFlag(QUANTUM_BOARD_FLAG) === true;
  return useCallback(
    (boardType: string) => isBoardTypeVisible(boardType, { [QUANTUM_BOARD_FLAG]: quantumEnabled }),
    [quantumEnabled],
  );
}

export function useIsBoardConfigVisible() {
  const quantumEnabled = useFeatureFlag(QUANTUM_BOARD_FLAG) === true;
  return useCallback(
    (config: BoardVisibilityConfig) => isBoardConfigVisible(config, { [QUANTUM_BOARD_FLAG]: quantumEnabled }),
    [quantumEnabled],
  );
}
