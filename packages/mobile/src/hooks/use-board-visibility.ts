import { useCallback } from 'react';
import { useFeatureFlag } from '../providers/feature-flags-provider';

/** Rollout policy belongs at the catalogue boundary, never in board rows or renderers. */
export function useIsBoardTypeVisible() {
  const quantumEnabled = useFeatureFlag('quantum-board') === true;
  return useCallback((boardType: string) => boardType !== 'quantum' || quantumEnabled, [quantumEnabled]);
}
