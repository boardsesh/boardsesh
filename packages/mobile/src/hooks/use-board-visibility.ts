import { useCallback } from 'react';
import { isBoardTypeVisible, QUANTUM_BOARD_FLAG } from '@boardsesh/board-config/visibility';
import { useFeatureFlag } from '../providers/feature-flags-provider';

/** Rollout policy belongs at the catalogue boundary, never in board rows or renderers. */
export function useIsBoardTypeVisible() {
  const quantumEnabled = useFeatureFlag(QUANTUM_BOARD_FLAG) === true;
  return useCallback(
    (boardType: string) => isBoardTypeVisible(boardType, { [QUANTUM_BOARD_FLAG]: quantumEnabled }),
    [quantumEnabled],
  );
}
