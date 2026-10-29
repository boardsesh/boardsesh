import { useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardRenderMode } from '../../hooks/use-board-render-look';
import { useEffectiveHoldMarkers } from '../../hooks/marker-renderer-support';
import { holdStateColors } from './hold-state-colors';

/** The colour the player draws each hold role in, on this board, for this climber (`holdStateColors`). */
export function useHoldStateColors(boardName: BoardName, layoutId: number): ReadonlyMap<string, string> {
  const { colors } = useEffectiveHoldMarkers();
  const { mode } = useBoardRenderMode(boardName, layoutId);
  return useMemo(() => holdStateColors(boardName, mode, colors), [boardName, mode, colors]);
}
