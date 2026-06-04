import { useCallback, useMemo, useReducer } from 'react';
import type { HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { MOONBOARD_HOLD_STATES } from '@boardsesh/board-config';

type UseMoonBoardCreateClimbOptions = {
  initialHoldsMap?: LitUpHoldsMap;
};

const HISTORY_LIMIT = 50;

type HoldsHistory = {
  past: LitUpHoldsMap[];
  present: LitUpHoldsMap;
  future: LitUpHoldsMap[];
};

type HoldsAction =
  | { type: 'APPLY'; updater: (previous: LitUpHoldsMap) => LitUpHoldsMap }
  | { type: 'LOAD'; holds: LitUpHoldsMap }
  | { type: 'RESET' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

function capPast(past: LitUpHoldsMap[]): LitUpHoldsMap[] {
  return past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
}

function holdsReducer(history: HoldsHistory, action: HoldsAction): HoldsHistory {
  switch (action.type) {
    case 'APPLY': {
      const next = action.updater(history.present);
      if (next === history.present) return history;
      return { past: capPast([...history.past, history.present]), present: next, future: [] };
    }
    case 'LOAD': {
      if (action.holds === history.present) return history;
      return { past: [], present: action.holds, future: [] };
    }
    case 'RESET': {
      if (Object.keys(history.present).length === 0) return history;
      return { past: capPast([...history.past, history.present]), present: {}, future: [] };
    }
    case 'UNDO': {
      if (history.past.length === 0) return history;
      const previous = history.past[history.past.length - 1];
      return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
    }
    case 'REDO': {
      if (history.future.length === 0) return history;
      const next = history.future[0];
      return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
    }
    default:
      return history;
  }
}

function initHistory(initialHoldsMap: LitUpHoldsMap | undefined): HoldsHistory {
  return { past: [], present: initialHoldsMap ?? {}, future: [] };
}

/**
 * MoonBoard hold-state machine for the create-climb editor. MoonBoard differs
 * from Aurora: only Start/Hand/Finish roles, fixed green/blue/red colours, and
 * a publish rule of at least one start and one finish.
 */
export function useMoonBoardCreateClimb(options?: UseMoonBoardCreateClimbOptions) {
  const [history, dispatch] = useReducer(holdsReducer, options?.initialHoldsMap, initHistory);
  const litUpHoldsMap = history.present;

  const startingCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((hold) => hold.state === 'STARTING').length,
    [litUpHoldsMap],
  );

  const finishCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((hold) => hold.state === 'FINISH').length,
    [litUpHoldsMap],
  );

  const handCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((hold) => hold.state === 'HAND').length,
    [litUpHoldsMap],
  );

  const totalHolds = useMemo(() => Object.keys(litUpHoldsMap).length, [litUpHoldsMap]);
  const isValid = totalHolds > 0 && startingCount >= 1 && finishCount >= 1;

  const setLitUpHoldsMap = useCallback((nextHoldsMap: LitUpHoldsMap) => {
    dispatch({ type: 'LOAD', holds: nextHoldsMap });
  }, []);

  const setHoldState = useCallback((holdId: number, nextState: HoldState | 'OFF') => {
    dispatch({
      type: 'APPLY',
      updater: (previousHoldsMap) => {
        if (nextState === 'OFF') {
          if (!(holdId in previousHoldsMap)) return previousHoldsMap;
          const { [holdId]: _removed, ...rest } = previousHoldsMap;
          void _removed;
          return rest;
        }

        if (nextState !== 'STARTING' && nextState !== 'HAND' && nextState !== 'FINISH') {
          return previousHoldsMap;
        }

        const currentHold = previousHoldsMap[holdId];
        if (currentHold?.state === nextState) return previousHoldsMap;

        if (nextState === 'STARTING') {
          const currentStartingCount = Object.values(previousHoldsMap).filter(
            (hold) => hold.state === 'STARTING',
          ).length;
          if (currentStartingCount >= 2) return previousHoldsMap;
        }
        if (nextState === 'FINISH') {
          const currentFinishCount = Object.values(previousHoldsMap).filter((hold) => hold.state === 'FINISH').length;
          if (currentFinishCount >= 2) return previousHoldsMap;
        }

        const stateToMoonBoard = {
          STARTING: MOONBOARD_HOLD_STATES.start,
          HAND: MOONBOARD_HOLD_STATES.hand,
          FINISH: MOONBOARD_HOLD_STATES.finish,
        } as const;

        const stateInfo = stateToMoonBoard[nextState];

        return {
          ...previousHoldsMap,
          [holdId]: {
            state: nextState,
            color: stateInfo.color,
            displayColor: stateInfo.displayColor,
          },
        };
      },
    });
  }, []);

  const resetHolds = useCallback(() => dispatch({ type: 'RESET' }), []);
  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);

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
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
