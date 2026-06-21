import { useCallback, useMemo, useReducer } from 'react';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

type UseCreateClimbOptions = {
  initialHoldsMap?: LitUpHoldsMap;
};

// Drop holds whose state the board doesn't support (e.g. a colour-only / MoonBoard
// product without FOOT), so a fork or draft seeded from another board never carries
// an unpaintable hold.
function filterSupportedHoldsMap(boardName: BoardName, holdsMap: LitUpHoldsMap): LitUpHoldsMap {
  const stateToCode = STATE_TO_PRIMARY_CODE[boardName];
  return Object.fromEntries(
    Object.entries(holdsMap).filter(([, hold]) => hold.state !== 'OFF' && stateToCode[hold.state] !== undefined),
  ) as LitUpHoldsMap;
}

/** Max number of editing steps kept for undo. Oldest steps fall off the front. */
export const HISTORY_LIMIT = 50;

/**
 * Past/present/future undo history for the holds map. `present` is the live
 * map; `past`/`future` are full snapshots (the maps are small immutable
 * objects, so snapshotting is cheap). History is in-memory only — it resets on
 * remount, which is exactly the "current editing session" scope we want.
 */
export type HoldsHistory = {
  past: LitUpHoldsMap[];
  present: LitUpHoldsMap;
  future: LitUpHoldsMap[];
};

type HoldsAction =
  // Apply a functional update to the present map (paint/erase). Records history
  // only when the updater returns a *new* reference, so every no-op early-out
  // in `setHoldState` (blocked max-2, OFF-on-absent, same-state repaint) leaves
  // history untouched.
  | { type: 'APPLY'; updater: (prev: LitUpHoldsMap) => LitUpHoldsMap }
  // Replace the map wholesale and establish a fresh baseline (draft load / edit
  // seed / fork). You can't undo across a load into the pre-load state.
  | { type: 'LOAD'; holds: LitUpHoldsMap }
  // Clear all holds — undoable (one undo restores them).
  | { type: 'RESET' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

function capPast(past: LitUpHoldsMap[]): LitUpHoldsMap[] {
  return past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
}

export function holdsReducer(state: HoldsHistory, action: HoldsAction): HoldsHistory {
  switch (action.type) {
    case 'APPLY': {
      const next = action.updater(state.present);
      if (next === state.present) return state;
      return { past: capPast([...state.past, state.present]), present: next, future: [] };
    }
    case 'LOAD': {
      if (action.holds === state.present) return state;
      return { past: [], present: action.holds, future: [] };
    }
    case 'RESET': {
      if (Object.keys(state.present).length === 0) return state;
      return { past: capPast([...state.past, state.present]), present: {}, future: [] };
    }
    case 'UNDO': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
    }
    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return { past: capPast([...state.past, state.present]), present: next, future: state.future.slice(1) };
    }
    default:
      return state;
  }
}

function initHistory(boardName: BoardName, initialHoldsMap: LitUpHoldsMap | undefined): HoldsHistory {
  return { past: [], present: filterSupportedHoldsMap(boardName, initialHoldsMap ?? {}), future: [] };
}

/**
 * Aurora (Kilter/Tension/etc) hold-state machine for the create-climb editor.
 * Pure React + board-constants — shared verbatim by the web form and the
 * React Native editor. Keys holds by numeric id; enforces the max-2
 * STARTING/FINISH rule; serialises to the Aurora `p{holdId}r{code}` frame
 * string. Tracks in-memory undo/redo history for the current editing session.
 */
export function useCreateClimb(boardName: BoardName, options?: UseCreateClimbOptions) {
  // The editor mounts once per board route today, so this initial sanitizer only
  // needs the mount-time board. If a future caller swaps boardName mid-mount,
  // remount this hook or re-sanitize the present map on board change.
  const [history, dispatch] = useReducer(holdsReducer, options?.initialHoldsMap, (initial) =>
    initHistory(boardName, initial),
  );
  const litUpHoldsMap = history.present;

  // Derived state: count holds by type
  const startingCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state === 'STARTING').length,
    [litUpHoldsMap],
  );

  const finishCount = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state === 'FINISH').length,
    [litUpHoldsMap],
  );

  const totalHolds = useMemo(
    () => Object.values(litUpHoldsMap).filter((h) => h.state !== 'OFF').length,
    [litUpHoldsMap],
  );

  const isValid = totalHolds > 0;

  const setHoldState = useCallback(
    (holdId: number, nextState: HoldState | 'OFF') => {
      dispatch({
        type: 'APPLY',
        updater: (prev) => {
          // Clearing a hold removes it from the map.
          if (nextState === 'OFF') {
            if (!(holdId in prev)) return prev;
            const { [holdId]: _removed, ...rest } = prev;
            void _removed;
            return rest;
          }

          // Re-painting a hold to the state it already has is a true no-op —
          // keeps undo history clean (no redundant steps) and avoids re-renders.
          const currentHold = prev[holdId];
          if (currentHold?.state === nextState) return prev;

          // Enforce max-2 STARTING / FINISH limits as a safety net — the picker
          // already disables these options when at the cap.
          if (nextState === 'STARTING') {
            const startingCount = Object.values(prev).filter((h) => h.state === 'STARTING').length;
            if (startingCount >= 2) return prev;
          }
          if (nextState === 'FINISH') {
            const finishCount = Object.values(prev).filter((h) => h.state === 'FINISH').length;
            if (finishCount >= 2) return prev;
          }

          const stateCode = STATE_TO_PRIMARY_CODE[boardName][nextState];
          if (stateCode === undefined) {
            return prev;
          }

          const holdInfo = HOLD_STATE_MAP[boardName][stateCode];
          if (!holdInfo) {
            return prev;
          }

          return {
            ...prev,
            [holdId]: {
              state: nextState,
              color: holdInfo.color,
              displayColor: holdInfo.displayColor || holdInfo.color,
            },
          };
        },
      });
    },
    [boardName],
  );

  // Generate frames string in Aurora format: p{holdId}r{stateCode}p{holdId}r{stateCode}...
  // Holds whose state the board can't encode are skipped (parity with the init/load filter).
  const generateFramesString = useCallback(() => {
    const stateToCode = STATE_TO_PRIMARY_CODE[boardName];
    return Object.entries(litUpHoldsMap)
      .filter(([, hold]) => hold.state !== 'OFF')
      .flatMap(([holdId, hold]) => {
        const code = stateToCode[hold.state];
        return code === undefined ? [] : [`p${holdId}r${code}`];
      })
      .join('');
  }, [litUpHoldsMap, boardName]);

  // Reset all holds (undoable).
  const resetHolds = useCallback(() => dispatch({ type: 'RESET' }), []);

  // Replace the entire holds map in one shot (used when loading a draft back
  // into the form). Establishes a fresh undo baseline and drops unsupported holds.
  const loadHolds = useCallback(
    (next: LitUpHoldsMap) => dispatch({ type: 'LOAD', holds: filterSupportedHoldsMap(boardName, next) }),
    [boardName],
  );

  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);

  return {
    litUpHoldsMap,
    setHoldState,
    generateFramesString,
    startingCount,
    finishCount,
    totalHolds,
    isValid,
    resetHolds,
    loadHolds,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
