import { useLayoutEffect } from 'react';
import type { SwipePager } from './use-swipe-pager';

/**
 * Tells the pager the board in the middle keeps its wall still while it
 * changes climbs (`pager.stationaryMotion`): the GPU board, and the PNG board
 * fading in place. Under Reduce Motion the header then changes with the step
 * instead of sliding. Set while `active` and mounted; cleared when either ends.
 */
export function useStationaryMotionFlag(pager: SwipePager, active: boolean): void {
  const stationaryMotion = pager.stationaryMotion;
  useLayoutEffect(() => {
    if (!active || !stationaryMotion) return;
    stationaryMotion.value = true;
    return () => {
      stationaryMotion.value = false;
    };
  }, [active, stationaryMotion]);
}
