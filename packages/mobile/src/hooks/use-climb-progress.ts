import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { tickTimeMs } from '@boardsesh/profile-stats';
import { deriveClimbProgress, type ClimbProgress } from '../lib/climb-progress';

/**
 * What the climber has done on this climb at this angle — outcome, mirror state
 * and recency — or null when they have no history with it (and outside a
 * BoardProvider). Drives `ClimbProgressLine`, the rich tier's personal line.
 *
 * Reads the same pre-grouped `logbookByClimbAngle` index `useAscentStatus` does:
 * ONE `Map.get` over that climb's handful of ticks, never a scan or filter over
 * the whole logbook (docs/react-native-performance.md §4). The `useMemo` keys on
 * the bucket identity, which only changes when a merge actually touches this
 * climb's ticks.
 */
export function useClimbProgress(climbUuid: string, angle: number): ClimbProgress | null {
  const logbook = useOptionalBoardLogbook();
  const entries = logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  return useMemo(() => deriveClimbProgress(entries, tickTimeMs), [entries]);
}
