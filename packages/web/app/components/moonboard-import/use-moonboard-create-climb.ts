'use client';

import { useState, useCallback, useMemo } from 'react';
import type { LitUpHoldsMap, HoldState } from '../board-renderer/types';
import { MOONBOARD_HOLD_STATES } from '@/app/lib/moonboard-config';

type UseMoonBoardCreateClimbOptions = {
  initialHoldsMap?: LitUpHoldsMap;
};

export function useMoonBoardCreateClimb(options?: UseMoonBoardCreateClimbOptions) {
  const [litUpHoldsMap, setLitUpHoldsMap] = useState<LitUpHoldsMap>(options?.initialHoldsMap ?? {});

  // Derived state: count holds by state
  const startingCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state === 'STARTING').length,
    [litUpHoldsMap],
  );

  const finishCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state === 'FINISH').length,
    [litUpHoldsMap],
  );

  const handCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state === 'HAND').length,
    [litUpHoldsMap],
  );

  const totalHolds = useMemo(() => Object.keys(litUpHoldsMap).length, [litUpHoldsMap]);

  // MoonBoard climbs need at least 1 start hold and 1 finish hold
  const isValid = totalHolds > 0 && startingCount >= 1 && finishCount >= 1;

  const setHoldState = useCallback((holdId: number, nextState: HoldState | 'OFF') => {
    setLitUpHoldsMap((prev) => {
      // Clearing a hold removes it from the map.
      if (nextState === 'OFF') {
        if (!(holdId in prev)) return prev;
        const { [holdId]: _removed, ...rest } = prev;
        void _removed;
        return rest;
      }

      // MoonBoard has no FOOT state — silently no-op if asked.
      if (nextState !== 'STARTING' && nextState !== 'HAND' && nextState !== 'FINISH') {
        return prev;
      }

      // Enforce max-2 STARTING / FINISH limits as a safety net.
      const currentHold = prev[holdId];
      const isAlreadyThisState = currentHold?.state === nextState;
      if (!isAlreadyThisState) {
        if (nextState === 'STARTING') {
          const startingCount = Object.values(prev).filter((h) => h.state === 'STARTING').length;
          if (startingCount >= 2) return prev;
        }
        if (nextState === 'FINISH') {
          const finishCount = Object.values(prev).filter((h) => h.state === 'FINISH').length;
          if (finishCount >= 2) return prev;
        }
      }

      const stateToMoonboard = {
        STARTING: MOONBOARD_HOLD_STATES.start,
        HAND: MOONBOARD_HOLD_STATES.hand,
        FINISH: MOONBOARD_HOLD_STATES.finish,
      } as const;

      const stateInfo = stateToMoonboard[nextState];

      return {
        ...prev,
        [holdId]: {
          state: nextState,
          color: stateInfo.color,
          displayColor: stateInfo.displayColor,
        },
      };
    });
  }, []);

  // Reset all holds
  const resetHolds = useCallback(() => {
    setLitUpHoldsMap({});
  }, []);

  return {
    litUpHoldsMap,
    setLitUpHoldsMap,
    setHoldState,
    startingCount,
    finishCount,
    handCount,
    totalHolds,
    isValid,
    resetHolds,
  };
}
