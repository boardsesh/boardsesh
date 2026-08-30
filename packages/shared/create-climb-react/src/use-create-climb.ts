import { useCallback, useMemo, useReducer } from 'react';
import {
  HOLD_STATE_MAP,
  STATE_TO_PRIMARY_CODE,
  accumulatedMapsToFrameStrings,
  encodeMapsToFramesString,
  flattenFramesToUnion,
} from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

type UseCreateClimbOptions = {
  /** Seeds the editor's full frame sequence (a fork, an edit, or an autosave restore). */
  initialFrames?: LitUpHoldsMap[];
};

// Drop holds whose state the board doesn't support (e.g. a colour-only / MoonBoard
// product without FOOT), so a fork or draft seeded from another board never carries
// an unpaintable hold.
//
// `stateToCode` is optional-chained because this runs inside the `useReducer` lazy
// initialiser — i.e. DURING RENDER, where a throw is unrecoverable. A seeded map is
// the only way to reach the read at all: for a new climb the map is empty, so the
// filter callback never runs. That made an unknown `boardName` a remix/edit-only
// render crash (#3804). Degrading to "no supported holds" matches
// `accumulateFramesToMaps` in @boardsesh/board-constants, which already reads this
// same table with `?.`.
function filterSupportedHoldsMap(boardName: BoardName, holdsMap: LitUpHoldsMap): LitUpHoldsMap {
  const stateToCode = STATE_TO_PRIMARY_CODE[boardName];
  return Object.fromEntries(
    Object.entries(holdsMap).filter(([, hold]) => hold.state !== 'OFF' && stateToCode?.[hold.state] !== undefined),
  ) as LitUpHoldsMap;
}

function filterSupportedFrames(boardName: BoardName, frames: LitUpHoldsMap[]): LitUpHoldsMap[] {
  const filtered = frames.map((frame) => filterSupportedHoldsMap(boardName, frame));
  return filtered.length > 0 ? filtered : [{}];
}

/** Max number of editing steps kept for undo. Oldest steps fall off the front. */
export const HISTORY_LIMIT = 50;

/**
 * Past/present/future undo history for the editor's frame sequence. `present`
 * is the live sequence (one `LitUpHoldsMap` per frame); `past`/`future` hold
 * full `{present, currentFrameIndex}` snapshots — the maps are small
 * immutable objects, so snapshotting is cheap. History is in-memory only —
 * it resets on remount, which is exactly the "current editing session" scope
 * we want.
 *
 * Each snapshot pairs the frame sequence with which frame was active *at
 * that point*, so undo/redo restore both exactly — undoing a duplicate
 * lands you back where you started, redoing it returns you to the new frame
 * it created. Pure navigation (`nextFrame`/`prevFrame`/`goToFrame`) does NOT
 * push a snapshot — moving between frames isn't itself an edit — so it never
 * shows up as an undo step, but an undo/redo across it still restores the
 * exact index the bracketing edit captured.
 */
export type FramesSnapshot = { present: LitUpHoldsMap[]; currentFrameIndex: number };

export type FramesHistory = FramesSnapshot & {
  past: FramesSnapshot[];
  future: FramesSnapshot[];
};

type FramesAction =
  // Apply a functional update to the active frame (paint/erase). Records
  // history only when the updater returns a *new* reference, so every no-op
  // early-out in `setHoldState` (blocked max-2, OFF-on-absent, same-state
  // repaint) leaves history untouched.
  | { type: 'APPLY'; updater: (prev: LitUpHoldsMap) => LitUpHoldsMap }
  // Replace the whole frame sequence and establish a fresh undo baseline
  // (draft load / edit seed / fork / autosave restore). You can't undo across
  // a load into the pre-load state. `frames` must be non-empty.
  | { type: 'LOAD_FRAMES'; frames: LitUpHoldsMap[] }
  // Clear every frame back to a single empty one — undoable.
  | { type: 'RESET' }
  // Insert a copy of the active frame right after it and move there.
  | { type: 'DUPLICATE_FRAME' }
  // Remove the active frame (no-op with only one frame left).
  | { type: 'DELETE_FRAME' }
  // Pure navigation — not pushed to past/future.
  | { type: 'SET_FRAME_INDEX'; index: number }
  | { type: 'UNDO' }
  | { type: 'REDO' };

function capPast(past: FramesSnapshot[]): FramesSnapshot[] {
  return past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

function isEmptyFrame(frame: LitUpHoldsMap): boolean {
  return Object.keys(frame).length === 0;
}

/** The state before an action ran — what an UNDO of it should restore. */
function snapshotOf(state: FramesHistory): FramesSnapshot {
  return { present: state.present, currentFrameIndex: state.currentFrameIndex };
}

export function framesReducer(state: FramesHistory, action: FramesAction): FramesHistory {
  switch (action.type) {
    case 'APPLY': {
      const activeFrame = state.present[state.currentFrameIndex];
      const next = action.updater(activeFrame);
      if (next === activeFrame) return state;
      const present = state.present.map((frame, index) => (index === state.currentFrameIndex ? next : frame));
      return {
        past: capPast([...state.past, snapshotOf(state)]),
        present,
        future: [],
        currentFrameIndex: state.currentFrameIndex,
      };
    }
    case 'LOAD_FRAMES': {
      if (action.frames === state.present) return state;
      return { past: [], present: action.frames, future: [], currentFrameIndex: 0 };
    }
    case 'RESET': {
      if (state.present.length === 1 && isEmptyFrame(state.present[0])) return state;
      return { past: capPast([...state.past, snapshotOf(state)]), present: [{}], future: [], currentFrameIndex: 0 };
    }
    case 'DUPLICATE_FRAME': {
      const activeFrame = state.present[state.currentFrameIndex];
      const present = [
        ...state.present.slice(0, state.currentFrameIndex + 1),
        { ...activeFrame },
        ...state.present.slice(state.currentFrameIndex + 1),
      ];
      return {
        past: capPast([...state.past, snapshotOf(state)]),
        present,
        future: [],
        currentFrameIndex: state.currentFrameIndex + 1,
      };
    }
    case 'DELETE_FRAME': {
      if (state.present.length <= 1) return state;
      const present = state.present.filter((_, index) => index !== state.currentFrameIndex);
      return {
        past: capPast([...state.past, snapshotOf(state)]),
        present,
        future: [],
        currentFrameIndex: clampIndex(state.currentFrameIndex, present.length),
      };
    }
    case 'SET_FRAME_INDEX': {
      const index = clampIndex(action.index, state.present.length);
      if (index === state.currentFrameIndex) return state;
      return { ...state, currentFrameIndex: index };
    }
    case 'UNDO': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: previous.present,
        currentFrameIndex: previous.currentFrameIndex,
        future: [snapshotOf(state), ...state.future],
      };
    }
    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        past: capPast([...state.past, snapshotOf(state)]),
        present: next.present,
        currentFrameIndex: next.currentFrameIndex,
        future: state.future.slice(1),
      };
    }
    default:
      return state;
  }
}

function initHistory(boardName: BoardName, initialFrames: LitUpHoldsMap[] | undefined): FramesHistory {
  return {
    past: [],
    present: filterSupportedFrames(boardName, initialFrames ?? [{}]),
    future: [],
    currentFrameIndex: 0,
  };
}

/**
 * Aurora (Kilter/Tension/etc) hold-state machine for the create-climb editor.
 * Pure React + board-constants — shared verbatim by the web form and the
 * React Native editor. Keys holds by numeric id; enforces the max-2
 * STARTING/FINISH rule (per frame); serialises the whole frame sequence to
 * the Aurora frames string (delta-encoded past frame 0). Tracks in-memory
 * undo/redo history for the current editing session.
 *
 * `litUpHoldsMap` is always the *active* frame — every existing single-frame
 * consumer (board renderers, the hold-type picker, paint handlers) keeps
 * working unchanged. Multi-frame/route support is opt-in via `frameCount`,
 * `duplicateFrame`/`deleteFrame`, and the frame-navigation helpers below.
 */
export function useCreateClimb(boardName: BoardName, options?: UseCreateClimbOptions) {
  // The editor mounts once per board route today, so this initial sanitizer only
  // needs the mount-time board. If a future caller swaps boardName mid-mount,
  // remount this hook or re-sanitize the present frames on board change.
  const [history, dispatch] = useReducer(framesReducer, options?.initialFrames, (initial) =>
    initHistory(boardName, initial),
  );
  const litUpHoldsMap = history.present[history.currentFrameIndex] ?? {};
  const frameCount = history.present.length;
  const currentFrameIndex = history.currentFrameIndex;

  // Derived state, computed over the union of every frame in the route so
  // validity / duplicate-detection reflect the whole sequence, not just
  // whichever frame is on screen right now.
  const unionHolds = useMemo(() => flattenFramesToUnion(history.present), [history.present]);

  const startingCount = useMemo(
    () => Object.values(unionHolds).filter((h) => h.state === 'STARTING').length,
    [unionHolds],
  );

  const finishCount = useMemo(() => Object.values(unionHolds).filter((h) => h.state === 'FINISH').length, [unionHolds]);

  const totalHolds = useMemo(() => Object.values(unionHolds).filter((h) => h.state !== 'OFF').length, [unionHolds]);

  // Two thresholds, deliberately different, because the destinations carry
  // different risk:
  //  - `canSave` keeps a private draft cheap. Any painted hold is worth keeping,
  //    and tightening it would regress every draft that saves today.
  //  - `canPublish` gates the PUBLIC transition. Nothing else checks starts and
  //    finishes — SaveClimbInputSchema wants only a name and one non-empty frame
  //    — so without this a one-hold blob is one tap from being a public climb.
  // Scan the frames themselves rather than the flattened union. A hold can
  // legitimately change from STARTING in one frame to FINISH in a later frame;
  // the union keeps only its last state and would incorrectly reject that route.
  const canSave = totalHolds > 0;
  const canPublish = useMemo(() => {
    let hasStartingHold = false;
    let hasFinishHold = false;
    for (const frame of history.present) {
      for (const hold of Object.values(frame)) {
        if (hold.state === 'STARTING') hasStartingHold = true;
        if (hold.state === 'FINISH') hasFinishHold = true;
        if (hasStartingHold && hasFinishHold) return true;
      }
    }
    return false;
  }, [history.present]);

  /** Alias of `canSave`, kept for existing callers. Prefer `canSave` / `canPublish`. */
  const isValid = canSave;

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

          // Enforce max-2 STARTING / FINISH limits per frame as a safety net —
          // the picker already disables these options when at the cap.
          if (nextState === 'STARTING') {
            const startingCount = Object.values(prev).filter((h) => h.state === 'STARTING').length;
            if (startingCount >= 2) return prev;
          }
          if (nextState === 'FINISH') {
            const finishCount = Object.values(prev).filter((h) => h.state === 'FINISH').length;
            if (finishCount >= 2) return prev;
          }

          // Optional-chained for the same reason as `filterSupportedHoldsMap`: an
          // unknown board must not throw. Both reads already return `prev` when the
          // lookup misses, so this only widens "missing role" to "missing board".
          const stateCode = STATE_TO_PRIMARY_CODE[boardName]?.[nextState];
          if (stateCode === undefined) {
            return prev;
          }

          const holdInfo = HOLD_STATE_MAP[boardName]?.[stateCode];
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

  // Encode the whole route: frame 0 absolute, later frames delta-encoded.
  // Single-frame climbs produce the same flat string they always have.
  const generateFramesString = useCallback(
    () => encodeMapsToFramesString(history.present, boardName),
    [history.present, boardName],
  );

  // BLE-ready single-frame string for *just* the active frame — for the
  // live-preview-while-painting path, which must never see multi-frame
  // syntax (commas / `"` / `x` tokens the BLE packet builder can't parse).
  const currentFrameBleString = useCallback(
    () => accumulatedMapsToFrameStrings([litUpHoldsMap], boardName)[0] ?? '',
    [litUpHoldsMap, boardName],
  );

  // Reset every frame back to a single empty one (undoable).
  const resetHolds = useCallback(() => dispatch({ type: 'RESET' }), []);

  // Replace the entire frame sequence in one shot (draft load / edit seed /
  // fork / autosave restore). Establishes a fresh undo baseline and drops
  // unsupported holds from every frame.
  const loadFrames = useCallback(
    (frames: LitUpHoldsMap[]) => dispatch({ type: 'LOAD_FRAMES', frames: filterSupportedFrames(boardName, frames) }),
    [boardName],
  );

  // Convenience single-frame form of `loadFrames`.
  const loadHolds = useCallback((next: LitUpHoldsMap) => loadFrames([next]), [loadFrames]);

  const duplicateFrame = useCallback(() => dispatch({ type: 'DUPLICATE_FRAME' }), []);
  const deleteFrame = useCallback(() => dispatch({ type: 'DELETE_FRAME' }), []);
  const goToFrame = useCallback((index: number) => dispatch({ type: 'SET_FRAME_INDEX', index }), []);
  const nextFrame = useCallback(
    () => dispatch({ type: 'SET_FRAME_INDEX', index: currentFrameIndex + 1 }),
    [currentFrameIndex],
  );
  const prevFrame = useCallback(
    () => dispatch({ type: 'SET_FRAME_INDEX', index: currentFrameIndex - 1 }),
    [currentFrameIndex],
  );

  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);

  return {
    litUpHoldsMap,
    frames: history.present,
    frameCount,
    currentFrameIndex,
    setHoldState,
    generateFramesString,
    currentFrameBleString,
    startingCount,
    finishCount,
    totalHolds,
    isValid,
    canSave,
    canPublish,
    resetHolds,
    loadHolds,
    loadFrames,
    duplicateFrame,
    deleteFrame,
    goToFrame,
    nextFrame,
    prevFrame,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
