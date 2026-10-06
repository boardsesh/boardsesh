import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  ONBOARDING_TIP_SPRAY_ADD_HOLD_KEY,
  ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY,
  ONBOARDING_TIP_SPRAY_MAYBE_KEY,
  ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY,
} from '@boardsesh/key-value-storage';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';

/**
 * The spray editor's first-run hints, in the order they can appear:
 *
 * 1. `tap`: on open. "Tap a ring to pick it. Tap it again to switch it off."
 * 2. `maybe`: once hint 1 is out of the way, and only while the wall has maybes.
 * 3. `longPress`: after a few edits. "Press and hold a ring, then slide to move it."
 *
 * And one that waits to be asked: `addHold`, "Tap + to add a hold.", shown the
 * first time a tap on bare wall with nothing picked meets no hold — the tap
 * that used to add one. It jumps the queue, because it answers the climber's
 * own question, and it is marked seen by adding a hold or closing it.
 */
export type SprayHintId = 'tap' | 'maybe' | 'longPress' | 'addHold';

/** What the climber just did, as far as the hints care. */
export type SprayHintEvent =
  /** Picked a ring with a tap. Teaches nothing on its own: the tap hint is about the second tap. */
  | 'select'
  /** Switched a ring off or on. */
  | 'toggle'
  /** Added a hold. */
  | 'add'
  /** Kept a dashed maybe. Also counts as a toggle. */
  | 'maybe'
  /** Pressed and held a ring. */
  | 'longPress'
  /** Tapped bare wall with nothing picked: asks for the add-a-hold hint. */
  | 'bareWall'
  /** Any other edit (a move, a resize, a trace, a join, a delete). */
  | 'edit';

export const SPRAY_HINT_KEYS: Readonly<Record<SprayHintId, string>> = {
  tap: ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY,
  maybe: ONBOARDING_TIP_SPRAY_MAYBE_KEY,
  longPress: ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY,
  addHold: ONBOARDING_TIP_SPRAY_ADD_HOLD_KEY,
};

/** Edits before the long-press hint is worth a line: by then the climber has the basics. */
export const EDITS_BEFORE_LONG_PRESS_HINT = 3;

const HINT_IDS: readonly SprayHintId[] = ['tap', 'maybe', 'longPress', 'addHold'];

export type SprayHintsState = {
  /** Storage has answered. Nothing shows before it, so a seen hint never flashes up. */
  loaded: boolean;
  /** Done with: seen on an earlier visit, or used or closed on this one. */
  done: Readonly<Record<SprayHintId, boolean>>;
  /** Edits this session, for the long-press hint's gate. */
  edits: number;
  /** A tap on bare wall asked how to add a hold (or the "?" replayed the hints). */
  addHoldAsked: boolean;
  /** The "?" button replayed the hints: they run again, and the edit gate is off. */
  replaying: boolean;
};

export type SprayHintsAction =
  | { type: 'LOADED'; seen: Readonly<Record<SprayHintId, boolean>> }
  | { type: 'EVENT'; event: SprayHintEvent }
  | { type: 'DISMISS'; id: SprayHintId }
  | { type: 'REPLAY' };

const NONE_DONE: Readonly<Record<SprayHintId, boolean>> = {
  tap: false,
  maybe: false,
  longPress: false,
  addHold: false,
};

export const initialSprayHintsState: SprayHintsState = {
  loaded: false,
  done: NONE_DONE,
  edits: 0,
  addHoldAsked: false,
  replaying: false,
};

/** Which hints an event uses up. Keeping a maybe is a toggle too, so it clears both. */
export function hintsUsedBy(event: SprayHintEvent): readonly SprayHintId[] {
  if (event === 'toggle') return ['tap'];
  if (event === 'maybe') return ['tap', 'maybe'];
  if (event === 'add') return ['addHold'];
  if (event === 'longPress') return ['longPress'];
  return [];
}

/** Whether an event is an edit for the long-press hint's gate. Picking a ring or tapping bare wall changes nothing. */
function countsAsEdit(event: SprayHintEvent): boolean {
  return event !== 'longPress' && event !== 'select' && event !== 'bareWall';
}

export function sprayHintsReducer(state: SprayHintsState, action: SprayHintsAction): SprayHintsState {
  switch (action.type) {
    case 'LOADED':
      // OR-ed with what already happened: a climber quick enough to tap before
      // storage answered has still used that hint.
      return {
        ...state,
        loaded: true,
        done: {
          tap: state.done.tap || action.seen.tap,
          maybe: state.done.maybe || action.seen.maybe,
          longPress: state.done.longPress || action.seen.longPress,
          addHold: state.done.addHold || action.seen.addHold,
        },
      };
    case 'EVENT': {
      if (action.event === 'bareWall') return state.addHoldAsked ? state : { ...state, addHoldAsked: true };
      const used = hintsUsedBy(action.event);
      const counts = countsAsEdit(action.event);
      if (used.length === 0 && !counts) return state;
      const done = { ...state.done };
      for (const id of used) done[id] = true;
      return { ...state, done, edits: counts ? state.edits + 1 : state.edits };
    }
    case 'DISMISS':
      return state.done[action.id] ? state : { ...state, done: { ...state.done, [action.id]: true } };
    case 'REPLAY':
      return { loaded: true, done: NONE_DONE, edits: 0, addHoldAsked: true, replaying: true };
    default:
      return state;
  }
}

/** The one hint to show now, or null. One at a time, in order. */
export function visibleSprayHint(state: SprayHintsState, hasMaybes: boolean): SprayHintId | null {
  if (!state.loaded) return null;
  const addHoldDue = state.addHoldAsked && !state.done.addHold;
  // A bare-wall tap is a question asked right now, so its answer goes first.
  // A replay asks it too, but in its place after the tap hint.
  if (addHoldDue && !state.replaying) return 'addHold';
  if (!state.done.tap) return 'tap';
  if (addHoldDue) return 'addHold';
  if (hasMaybes && !state.done.maybe) return 'maybe';
  if (!state.done.longPress && (state.replaying || state.edits >= EDITS_BEFORE_LONG_PRESS_HINT)) return 'longPress';
  return null;
}

export type SprayEditorHints = {
  /** The hint to show, or null. */
  hint: SprayHintId | null;
  /** The climber closed the hint. Counts as seen, like using it. */
  dismiss: (id: SprayHintId) => void;
  /** Report what the climber did. Marks the hints it teaches as seen. Stable identity. */
  record: (event: SprayHintEvent) => void;
  /** Show every hint again from the first, for this session (the "?" button). */
  replay: () => void;
};

/**
 * First-run hints for the spray hold editor.
 *
 * A hint is marked seen when the climber does what it teaches, or closes it,
 * never merely because it showed: a hint glanced past while the rings swept in
 * has taught nothing. Doing the thing before the hint ever appears counts too,
 * so a climber who finds long press on their own is never told about it.
 *
 * `enabled` is false in screenshot mode and on a read-only wall: no hint
 * shows, the "?" replay does nothing, and nothing is written.
 */
export function useSprayEditorHints({
  enabled,
  hasMaybes,
}: {
  enabled: boolean;
  hasMaybes: boolean;
}): SprayEditorHints {
  const [state, dispatch] = useReducer(sprayHintsReducer, initialSprayHintsState);
  /** Keys already written this session, so a replayed hint used again is not written twice. */
  const writtenRef = useRef(new Set<string>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.all(HINT_IDS.map((id) => hasSeenTip(SPRAY_HINT_KEYS[id]))).then(([tap, maybe, longPress, addHold]) => {
      if (!cancelled) dispatch({ type: 'LOADED', seen: { tap, maybe, longPress, addHold } });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const persist = useCallback((ids: readonly SprayHintId[]) => {
    for (const id of ids) {
      const key = SPRAY_HINT_KEYS[id];
      if (writtenRef.current.has(key)) continue;
      writtenRef.current.add(key);
      // Best-effort: a failed write costs one repeat of a one-line hint.
      markTipSeen(key).catch(() => writtenRef.current.delete(key));
    }
  }, []);

  const record = useCallback(
    (event: SprayHintEvent) => {
      if (!enabledRef.current) return;
      dispatch({ type: 'EVENT', event });
      persist(hintsUsedBy(event));
    },
    [persist],
  );

  const dismiss = useCallback(
    (id: SprayHintId) => {
      if (!enabledRef.current) return;
      dispatch({ type: 'DISMISS', id });
      persist([id]);
    },
    [persist],
  );

  const replay = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ type: 'REPLAY' });
  }, []);

  const hint = enabled ? visibleSprayHint(state, hasMaybes) : null;
  return useMemo(() => ({ hint, dismiss, record, replay }), [hint, dismiss, record, replay]);
}
