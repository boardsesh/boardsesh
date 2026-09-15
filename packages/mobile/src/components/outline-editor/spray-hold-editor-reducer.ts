/**
 * The spray hold editor's whole state, as one pure reducer with undo.
 *
 * Modelled on `framesReducer` (`@boardsesh/create-climb-react`): a present, a
 * capped past and a future, with every mutating action pushing the state it
 * replaced. Snapshot-based rather than inverse-op based on purpose — a merge is
 * not trivially invertible, and "undo twice after a merge and a delete" is an
 * acceptance criterion, not a nice-to-have. Structural sharing keeps the cost
 * honest: a snapshot re-points at the same hold objects, so undoing over a
 * hundred-hold wall copies a hundred references, not a hundred holds.
 *
 * Holds live in a record keyed by id, not an array, because every per-hold
 * operation on this screen — the tap hit test, the selection ring, the review
 * badge, the dirty check — would otherwise be a scan per hold per render on a
 * wall that is allowed to carry 600 of them.
 *
 * Coordinates are BOARD px throughout (a wall's board frame is its photograph).
 * Nothing here maps to canonical coordinates; that is the write path's job.
 */

import { mergeHoldGeometry, type HoldGeometry } from './spray-hold-tools';

/** How many undo steps are kept. Matches the create-climb history limit. */
export const HISTORY_LIMIT = 50;

/**
 * Where a hold's geometry came from, in the wire's own spelling so the write
 * path never translates.
 */
export type SprayEditorHoldSource = 'MANUAL' | 'AUTO';

export type SprayEditorHold = HoldGeometry & {
  /**
   * The server's hold id, or a NEGATIVE id this session minted for a hold that
   * has never been written. Negative rather than a separate flag because the id
   * is also the React key, the selection token and the hit-test result, and a
   * hold that changes identity the moment it saves would break all three.
   */
  id: number;
  source: SprayEditorHoldSource;
  /** Detector confidence 0–1 for AUTO holds; null when a human drew it. */
  confidence: number | null;
  /**
   * An AUTO hold nobody has ruled on yet. Pending holds are DRAWN but never
   * WRITTEN: a candidate the owner has not looked at must not become a hold on
   * their wall just because they saved something else.
   */
  review: 'pending' | 'accepted';
  /** This session created or changed the hold, so it belongs in the next upsert. */
  dirty: boolean;
};

export type SprayEditorPresent = {
  holds: Readonly<Record<number, SprayEditorHold>>;
  /**
   * Server ids this session took off the wall. A hold with a negative id just
   * leaves `holds` — it was never there, so there is nothing to remove.
   */
  removedIds: readonly number[];
  /** Ids under the tools. Two at once is what makes Merge available. */
  selectedIds: readonly number[];
  /** The next negative id to mint. Counts down, so ids stay unique per session. */
  nextLocalId: number;
};

export type SprayEditorState = SprayEditorPresent & {
  past: readonly SprayEditorPresent[];
  future: readonly SprayEditorPresent[];
  /**
   * Candidates below this confidence are hidden and are not swept up by "Accept
   * all". NOT part of the history: it is a lens on the wall, and undoing a
   * delete should not also move the slider back.
   */
  threshold: number;
};

/** The confidence floor a wall opens at — the detector's own accept threshold. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

export type SprayEditorAction =
  /** Replace everything and start a fresh undo baseline (the wall's holds landed). */
  | { type: 'LOAD'; holds: readonly SprayEditorHold[] }
  /** Pure selection. Never pushes history — undo is for the wall, not the cursor. */
  | { type: 'SELECT'; ids: readonly number[] }
  | { type: 'TOGGLE_SELECT'; id: number }
  | { type: 'SET_THRESHOLD'; threshold: number }
  | { type: 'ADD_HOLD'; geometry: HoldGeometry }
  | { type: 'MOVE_HOLD'; id: number; cx: number; cy: number }
  | { type: 'RESIZE_HOLD'; id: number; r: number }
  | { type: 'SET_OUTLINE'; id: number; geometry: HoldGeometry }
  | { type: 'DELETE'; ids: readonly number[] }
  /** Exactly two ids, or nothing happens. */
  | { type: 'MERGE'; ids: readonly number[] }
  | { type: 'ACCEPT'; ids: readonly number[] }
  /** Every pending candidate at or above the current threshold. */
  | { type: 'ACCEPT_ALL' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

export function initialSprayEditorState(holds: readonly SprayEditorHold[] = []): SprayEditorState {
  return {
    ...presentFromHolds(holds),
    past: [],
    future: [],
    threshold: DEFAULT_CONFIDENCE_THRESHOLD,
  };
}

function presentFromHolds(holds: readonly SprayEditorHold[]): SprayEditorPresent {
  const byId: Record<number, SprayEditorHold> = {};
  let lowest = 0;
  for (const hold of holds) {
    byId[hold.id] = hold;
    if (hold.id < lowest) lowest = hold.id;
  }
  return { holds: byId, removedIds: [], selectedIds: [], nextLocalId: lowest - 1 };
}

function capPast(past: readonly SprayEditorPresent[]): readonly SprayEditorPresent[] {
  return past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
}

function snapshotOf(state: SprayEditorState): SprayEditorPresent {
  return {
    holds: state.holds,
    removedIds: state.removedIds,
    selectedIds: state.selectedIds,
    nextLocalId: state.nextLocalId,
  };
}

/** Commit a new present, recording the one it replaced. Redo is dropped, as everywhere. */
function commit(state: SprayEditorState, present: SprayEditorPresent): SprayEditorState {
  return { ...state, ...present, past: capPast([...state.past, snapshotOf(state)]), future: [] };
}

/** The same hold with `dirty` set — every geometry change has to be written back. */
function touched(hold: SprayEditorHold, changes: Partial<SprayEditorHold>): SprayEditorHold {
  return { ...hold, ...changes, dirty: true };
}

export function sprayEditorReducer(state: SprayEditorState, action: SprayEditorAction): SprayEditorState {
  switch (action.type) {
    case 'LOAD': {
      return { ...state, ...presentFromHolds(action.holds), past: [], future: [] };
    }

    case 'SELECT': {
      const ids = action.ids.filter((id) => state.holds[id] != null);
      if (sameIds(ids, state.selectedIds)) return state;
      return { ...state, selectedIds: ids };
    }

    case 'TOGGLE_SELECT': {
      if (state.holds[action.id] == null) return state;
      const selected = state.selectedIds.includes(action.id)
        ? state.selectedIds.filter((id) => id !== action.id)
        : [...state.selectedIds, action.id];
      return { ...state, selectedIds: selected };
    }

    case 'SET_THRESHOLD': {
      const threshold = Math.min(1, Math.max(0, action.threshold));
      return threshold === state.threshold ? state : { ...state, threshold };
    }

    case 'ADD_HOLD': {
      const id = state.nextLocalId;
      const hold: SprayEditorHold = {
        ...action.geometry,
        id,
        source: 'MANUAL',
        confidence: null,
        // A hold the owner drew is not a candidate — there is nobody else to
        // review it, and making them accept their own stroke would be absurd.
        review: 'accepted',
        dirty: true,
      };
      return commit(state, {
        holds: { ...state.holds, [id]: hold },
        removedIds: state.removedIds,
        selectedIds: [id],
        nextLocalId: id - 1,
      });
    }

    case 'MOVE_HOLD': {
      const hold = state.holds[action.id];
      if (!hold) return state;
      if (hold.cx === action.cx && hold.cy === action.cy) return state;
      return commit(state, {
        ...snapshotOf(state),
        holds: { ...state.holds, [action.id]: touched(hold, { cx: action.cx, cy: action.cy }) },
      });
    }

    case 'RESIZE_HOLD': {
      const hold = state.holds[action.id];
      if (!hold || !(action.r > 0) || hold.r === action.r) return state;
      return commit(state, {
        ...snapshotOf(state),
        holds: { ...state.holds, [action.id]: touched(hold, { r: action.r }) },
      });
    }

    case 'SET_OUTLINE': {
      const hold = state.holds[action.id];
      if (!hold) return state;
      return commit(state, {
        ...snapshotOf(state),
        holds: { ...state.holds, [action.id]: touched(hold, action.geometry) },
      });
    }

    case 'DELETE': {
      const doomed = action.ids.filter((id) => state.holds[id] != null);
      if (doomed.length === 0) return state;
      const holds = { ...state.holds };
      // A hold this session drew is dropped outright; one the wall already had is
      // recorded so `removeSprayWallHolds` can stamp it off the draft. That split
      // is the server's own (docs/spray-walls.md, "Adding and removing holds").
      const removedIds = [...state.removedIds];
      for (const id of doomed) {
        delete holds[id];
        if (id > 0 && !removedIds.includes(id)) removedIds.push(id);
      }
      return commit(state, {
        holds,
        removedIds,
        selectedIds: state.selectedIds.filter((id) => holds[id] != null),
        nextLocalId: state.nextLocalId,
      });
    }

    case 'MERGE': {
      const [firstId, secondId] = action.ids;
      const first = state.holds[firstId];
      const second = state.holds[secondId];
      if (action.ids.length !== 2 || !first || !second || firstId === secondId) return state;
      const geometry = mergeHoldGeometry(first, second);
      if (!geometry) return state;
      // The survivor is whichever of the two the wall already knows about, so the
      // merge is a CORRECTION of a stored hold rather than a delete-plus-add that
      // would orphan every climb set on it.
      const survivorId = firstId > 0 ? firstId : secondId > 0 ? secondId : firstId;
      const victimId = survivorId === firstId ? secondId : firstId;
      const survivor = state.holds[survivorId];
      const holds = { ...state.holds };
      delete holds[victimId];
      holds[survivorId] = touched(survivor, {
        ...geometry,
        // A merge of a candidate and a hand-drawn hold is hand-drawn work.
        source: 'MANUAL',
        confidence: null,
        review: 'accepted',
      });
      const removedIds = [...state.removedIds];
      if (victimId > 0 && !removedIds.includes(victimId)) removedIds.push(victimId);
      return commit(state, {
        holds,
        removedIds,
        selectedIds: [survivorId],
        nextLocalId: state.nextLocalId,
      });
    }

    case 'ACCEPT': {
      const holds = { ...state.holds };
      let changed = false;
      for (const id of action.ids) {
        const hold = holds[id];
        if (!hold || hold.review === 'accepted') continue;
        // `dirty` too: an accepted candidate has never been written, so accepting
        // it is precisely what puts it in the next upsert.
        holds[id] = { ...hold, review: 'accepted', dirty: true };
        changed = true;
      }
      if (!changed) return state;
      return commit(state, { ...snapshotOf(state), holds });
    }

    case 'ACCEPT_ALL': {
      const ids = pendingCandidateIds(state).filter((id) => (state.holds[id].confidence ?? 0) >= state.threshold);
      return ids.length === 0 ? state : sprayEditorReducer(state, { type: 'ACCEPT', ids });
    }

    case 'UNDO': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        ...previous,
        past: state.past.slice(0, -1),
        future: [snapshotOf(state), ...state.future],
      };
    }

    case 'REDO': {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        ...state,
        ...next,
        past: capPast([...state.past, snapshotOf(state)]),
        future: rest,
      };
    }

    default:
      return state;
  }
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// ---------------------------------------------------------------------------
// Selectors. Every one of these is called from a `useMemo` in the screen, so
// they are pure and take the state rather than reading it out of a closure.
// ---------------------------------------------------------------------------

/** Every hold, in id order so the SVG layer's path buckets are stable across renders. */
export function allHolds(state: SprayEditorPresent): SprayEditorHold[] {
  return Object.values(state.holds).sort((left, right) => left.id - right.id);
}

/** AUTO holds nobody has ruled on yet, whatever their confidence. */
export function pendingCandidateIds(state: SprayEditorPresent): number[] {
  return allHolds(state)
    .filter((hold) => hold.review === 'pending')
    .map((hold) => hold.id);
}

/**
 * Is this candidate hidden by the slider?
 *
 * Only pending candidates are ever hidden. Once a hold is accepted it is a hold
 * on the wall, and hiding it because the detector was unsure would make the
 * slider delete work the owner already approved.
 */
export function isHiddenByThreshold(hold: SprayEditorHold, threshold: number): boolean {
  return hold.review === 'pending' && (hold.confidence ?? 0) < threshold;
}

/** The holds to draw and hit-test at the current threshold. */
export function visibleHolds(state: SprayEditorState): SprayEditorHold[] {
  return allHolds(state).filter((hold) => !isHiddenByThreshold(hold, state.threshold));
}

export type SprayEditorCounts = {
  /** Holds that would be on the wall if it saved right now. */
  alive: number;
  /** Candidates still awaiting a verdict. */
  pending: number;
  /** Candidates the slider is currently hiding. */
  hidden: number;
  /** Holds queued for `upsertSprayWallHolds`. */
  unsavedWrites: number;
  /** Holds queued for `removeSprayWallHolds`. */
  unsavedRemovals: number;
};

export function editorCounts(state: SprayEditorState): SprayEditorCounts {
  let alive = 0;
  let pending = 0;
  let hidden = 0;
  let unsavedWrites = 0;
  for (const hold of Object.values(state.holds)) {
    if (hold.review === 'pending') {
      pending += 1;
      if (isHiddenByThreshold(hold, state.threshold)) hidden += 1;
    } else {
      alive += 1;
      if (hold.dirty) unsavedWrites += 1;
    }
  }
  return { alive, pending, hidden, unsavedWrites, unsavedRemovals: state.removedIds.length };
}

/** Anything at all to save? Drives the Save button and the unsaved-work guard. */
export function hasUnsavedWork(state: SprayEditorState): boolean {
  const counts = editorCounts(state);
  return counts.unsavedWrites > 0 || counts.unsavedRemovals > 0;
}
