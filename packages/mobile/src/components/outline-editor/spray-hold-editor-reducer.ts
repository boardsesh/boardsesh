/**
 * The spray hold editor's whole state, as one pure reducer with undo and redo.
 *
 * Modelled on `framesReducer` (`@boardsesh/create-climb-react`): a present, a
 * capped past and a future, with every mutating action pushing the state it
 * replaced onto the past and dropping the future. Snapshot-based rather than
 * inverse-op based on purpose — a merge is not trivially invertible, and "undo
 * twice after a join and a delete" has to work. Structural sharing keeps the
 * cost honest: a snapshot re-points at the same hold objects, so undoing over a
 * hundred-hold wall copies a hundred references, not a hundred holds. Undo
 * moves the present onto the future and Redo moves it back; any new edit
 * forgets the future, as every undo stack does.
 *
 * Holds live in a record keyed by id, not an array, because every per-hold
 * operation on this screen — the tap hit test, the selection ring, the dirty
 * check — would otherwise be a scan per hold per render on a wall that is
 * allowed to carry 1500 of them.
 *
 * The climber's model is "rings are holds, tap one to pick it, tap it again to
 * switch it off or on". Nothing a tap does takes a hold off the photo: a switched
 * off ring stays drawn as a ghost until the climber Deletes it. Every
 * hold therefore has a ROLE (`holdRole`): on, maybe or off. The role is derived
 * from `review` plus the detector's confidence, so a fresh detector run needs no
 * per-hold decision to open with its confident finds already on.
 *
 * Coordinates are BOARD px throughout (a wall's board frame is its photograph).
 * Nothing here maps to canonical coordinates; that is the write path's job.
 */

import { mergeHoldGeometry, SPRAY_ON_CUTOFF, type HoldGeometry } from './spray-hold-tools';

/** How many undo steps are kept. Matches the create-climb history limit. */
export const HISTORY_LIMIT = 50;

/**
 * Where a hold's geometry came from, in the wire's own spelling so the write
 * path never translates.
 */
export type SprayEditorHoldSource = 'MANUAL' | 'AUTO';

/**
 * What the climber has said about a hold.
 *
 * - `pending`: nothing yet. A detector find; its confidence decides whether it
 *   reads as ON or as a MAYBE.
 * - `accepted`: ON, because the climber said so (or it is already on the wall).
 * - `rejected`: switched OFF. Still drawn, as a faint ghost the climber can tap
 *   back on, and never written.
 */
export type SprayHoldReview = 'pending' | 'accepted' | 'rejected';

export type SprayEditorHold = HoldGeometry & {
  /**
   * The server's hold id, or a NEGATIVE id this session minted for a hold that
   * has never been written. Negative rather than a separate flag because the id
   * is also the selection token and the hit-test result, and a hold that changes
   * identity the moment it saves would break both.
   */
  id: number;
  source: SprayEditorHoldSource;
  /** Detector confidence 0–1 for AUTO holds; null when a human drew it. */
  confidence: number | null;
  review: SprayHoldReview;
  /** This session created or changed the hold, so it belongs in the next upsert. */
  dirty: boolean;
  /**
   * The removed hold this one puts back (#5493): set on a hold added from a
   * climb's "Put this hold back on the wall", and sent with it, so the climb
   * editor can find the new hold once the wall is published. A removed hold's
   * own id can never come back — the server refuses any id that is not alive —
   * so putting a hold back is always a NEW hold that names the old one.
   */
  movedFromHoldId?: number;
};

export type SprayEditorPresent = {
  holds: Readonly<Record<number, SprayEditorHold>>;
  /**
   * Server ids this session took off the wall — removed outright, or switched
   * off. A hold with a negative id is never listed: it was never there, so there
   * is nothing to remove.
   */
  removedIds: readonly number[];
  /** The one hold under the chip bar, or null. Single-select only. */
  selectedId: number | null;
  /** The next negative id to mint. Counts down, so ids stay unique per session. */
  nextLocalId: number;
};

export type SprayEditorState = SprayEditorPresent & {
  past: readonly SprayEditorPresent[];
  /** What Redo brings back, the next one LAST. Emptied by every new edit. */
  future: readonly SprayEditorPresent[];
};

export type SprayEditorAction =
  /** Replace everything and start a fresh undo baseline (the wall's holds landed). */
  | { type: 'LOAD'; holds: readonly SprayEditorHold[] }
  /** Go back to a seed, as one undoable step ("Start over"). */
  | { type: 'START_OVER'; holds: readonly SprayEditorHold[] }
  /** Pure selection. Never pushes history — undo is for the wall, not the cursor. */
  | { type: 'SELECT'; id: number | null }
  /** Tapping the selected ring: ON goes OFF (a ghost), OFF or MAYBE goes ON. */
  | { type: 'TOGGLE_HOLD'; id: number }
  /** An ON ring or a MAYBE goes OFF (a ghost). Already OFF does nothing. The maybe's "Switch off" chip. */
  | { type: 'SWITCH_OFF'; id: number }
  | { type: 'ADD_HOLD'; geometry: HoldGeometry; movedFromHoldId?: number }
  | { type: 'MOVE_HOLD'; id: number; cx: number; cy: number }
  | { type: 'RESIZE_HOLD'; id: number; r: number }
  | { type: 'SET_OUTLINE'; id: number; geometry: HoldGeometry }
  /**
   * Take a hold off entirely — no ghost left behind. The screen only offers it
   * for a ghost, so every removal is two deliberate steps and the second one
   * says so with an undo toast.
   */
  | { type: 'DELETE'; id: number }
  /** Exactly two ids, or nothing happens. */
  | { type: 'MERGE'; ids: readonly number[] }
  /**
   * Every confident pending find becomes an accepted, dirty hold. Run once, by
   * `prepareCommit`, right before the write plan is built. Not undoable: it
   * changes nothing the climber can see (a confident find already reads as ON).
   */
  | { type: 'ACCEPT_DEFAULTS' }
  /** Every maybe becomes an accepted hold ("Keep all maybes"). */
  | { type: 'KEEP_MAYBES' }
  /**
   * The server took the holds named in `writtenIds`, and only those.
   *
   * Named rather than "everything", because a plan that SUCCEEDS can still leave
   * holds out of it — one drawn while the request was in flight — and clearing
   * `dirty` on those too would let the next re-seed silently delete them.
   *
   * Clears without waiting for the refetch, so a second commit cannot re-send
   * holds the server has already applied. It also drops the undo history and
   * the redo future: a snapshot from before the write still holds those finds
   * as pending with no dirty flag, and undoing (or redoing) into it would let
   * the next commit write them a second time.
   */
  | { type: 'MARK_SAVED'; writtenIds: readonly number[] }
  /**
   * `removeSprayWallHolds` came back, and the upsert has not run yet.
   *
   * Its own action because the two calls are the two halves of one commit and
   * the second can fail on its own. Without this, `removedIds` would still name
   * holds the server has already stamped off, and every retry for the rest of
   * the session would be refused with "Hold N is not on this wall".
   */
  | { type: 'MARK_REMOVED' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

export function initialSprayEditorState(holds: readonly SprayEditorHold[] = []): SprayEditorState {
  return { ...presentFromHolds(holds), past: [], future: [] };
}

function lowestId(holds: readonly SprayEditorHold[]): number {
  let lowest = 0;
  for (const hold of holds) {
    if (hold.id < lowest) lowest = hold.id;
  }
  return lowest;
}

function presentFromHolds(holds: readonly SprayEditorHold[]): SprayEditorPresent {
  const byId: Record<number, SprayEditorHold> = {};
  for (const hold of holds) byId[hold.id] = hold;
  return { holds: byId, removedIds: [], selectedId: null, nextLocalId: lowestId(holds) - 1 };
}

/** Keeps the newest `HISTORY_LIMIT` snapshots. Both stacks keep their newest entry last. */
function capHistory(history: readonly SprayEditorPresent[]): readonly SprayEditorPresent[] {
  return history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history;
}

function snapshotOf(state: SprayEditorState): SprayEditorPresent {
  return {
    holds: state.holds,
    removedIds: state.removedIds,
    selectedId: state.selectedId,
    nextLocalId: state.nextLocalId,
  };
}

/** Commit a new present, recording the one it replaced. A new edit forgets what Redo could bring back. */
function commit(state: SprayEditorState, present: SprayEditorPresent): SprayEditorState {
  return { ...state, ...present, past: capHistory([...state.past, snapshotOf(state)]), future: [] };
}

function withoutId(ids: readonly number[], id: number): readonly number[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : ids;
}

function withId(ids: readonly number[], id: number): readonly number[] {
  return id > 0 && !ids.includes(id) ? [...ids, id] : ids;
}

/**
 * The same hold, changed by hand. Editing a hold is keeping it: nobody fixes the
 * outline of a hold they want off the wall, so every geometry change also turns
 * the hold ON and marks it for the next upsert.
 */
function touched(hold: SprayEditorHold, changes: Partial<SprayEditorHold>): SprayEditorHold {
  return { ...hold, ...changes, review: 'accepted', dirty: true };
}

/** Commit one edited hold, taking a stored one back off the removal list. */
function commitEdit(state: SprayEditorState, hold: SprayEditorHold): SprayEditorState {
  return commit(state, {
    ...snapshotOf(state),
    holds: { ...state.holds, [hold.id]: hold },
    removedIds: withoutId(state.removedIds, hold.id),
  });
}

/**
 * A maybe or an OFF ring goes ON. A stored hold keeps its own dirty flag:
 * switching it off and back on changed nothing about it, and re-sending it as a
 * correction would supersede its id for no reason.
 */
function switchOn(state: SprayEditorState, hold: SprayEditorHold): SprayEditorState {
  return commitEdit(state, { ...hold, review: 'accepted', dirty: hold.id > 0 ? hold.dirty : true });
}

/**
 * An ON ring or a maybe goes OFF and stays drawn as a ghost — every kind of
 * hold, a ring this session drew by hand included, so no tap ever makes a hold
 * vanish. A ghost is never written (`buildSprayHoldWritePlan` skips rejected
 * holds, and a re-seed drops a hand-drawn one), and a stored one is queued for
 * removal too, so Publish takes it off the draft.
 */
function switchOff(state: SprayEditorState, hold: SprayEditorHold): SprayEditorState {
  return commit(state, {
    ...snapshotOf(state),
    holds: { ...state.holds, [hold.id]: { ...hold, review: 'rejected' } },
    removedIds: withId(state.removedIds, hold.id),
  });
}

export function sprayEditorReducer(state: SprayEditorState, action: SprayEditorAction): SprayEditorState {
  switch (action.type) {
    case 'LOAD': {
      return { ...state, ...presentFromHolds(action.holds), past: [], future: [] };
    }

    case 'START_OVER': {
      const seed = presentFromHolds(action.holds);
      // Below every id the history can still reach, so a hold added after
      // starting over can never share an id with one an undo would bring back.
      return commit(state, { ...seed, nextLocalId: Math.min(seed.nextLocalId, state.nextLocalId) });
    }

    case 'SELECT': {
      const id = action.id != null && state.holds[action.id] != null ? action.id : null;
      if (id === state.selectedId) return state;
      return { ...state, selectedId: id };
    }

    case 'TOGGLE_HOLD': {
      const hold = state.holds[action.id];
      if (!hold) return state;
      return holdRole(hold) === 'on' ? switchOff(state, hold) : switchOn(state, hold);
    }

    case 'SWITCH_OFF': {
      const hold = state.holds[action.id];
      if (!hold || holdRole(hold) === 'off') return state;
      return switchOff(state, hold);
    }

    case 'ADD_HOLD': {
      const id = state.nextLocalId;
      const hold: SprayEditorHold = {
        ...action.geometry,
        id,
        source: 'MANUAL',
        confidence: null,
        // A hold the owner placed is not a candidate — there is nobody else to
        // review it.
        review: 'accepted',
        dirty: true,
        ...(action.movedFromHoldId != null ? { movedFromHoldId: action.movedFromHoldId } : {}),
      };
      return commit(state, {
        ...snapshotOf(state),
        holds: { ...state.holds, [id]: hold },
        nextLocalId: id - 1,
      });
    }

    case 'MOVE_HOLD': {
      const hold = state.holds[action.id];
      if (!hold) return state;
      if (hold.cx === action.cx && hold.cy === action.cy) return state;
      return commitEdit(state, touched(hold, { cx: action.cx, cy: action.cy }));
    }

    case 'RESIZE_HOLD': {
      const hold = state.holds[action.id];
      if (!hold || !(action.r > 0) || hold.r === action.r) return state;
      return commitEdit(state, touched(hold, { r: action.r }));
    }

    case 'SET_OUTLINE': {
      const hold = state.holds[action.id];
      if (!hold) return state;
      return commitEdit(state, touched(hold, action.geometry));
    }

    case 'DELETE': {
      if (state.holds[action.id] == null) return state;
      const holds = { ...state.holds };
      delete holds[action.id];
      // A hold this session drew is dropped outright; one the wall already had is
      // recorded so `removeSprayWallHolds` can stamp it off the draft. That split
      // is the server's own (docs/spray-walls.md, "Adding and removing holds").
      return commit(state, {
        ...snapshotOf(state),
        holds,
        removedIds: withId(state.removedIds, action.id),
        selectedId: null,
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
      const holds = { ...state.holds };
      delete holds[victimId];
      holds[survivorId] = touched(state.holds[survivorId], {
        ...geometry,
        // A join of a find and a hand-drawn hold is hand-drawn work.
        source: 'MANUAL',
        confidence: null,
      });
      return commit(state, {
        holds,
        removedIds: withId(withoutId(state.removedIds, survivorId), victimId),
        selectedId: null,
        nextLocalId: state.nextLocalId,
      });
    }

    case 'ACCEPT_DEFAULTS': {
      let holds: Record<number, SprayEditorHold> | null = null;
      for (const hold of Object.values(state.holds)) {
        if (hold.review !== 'pending' || holdRole(hold) !== 'on') continue;
        holds ??= { ...state.holds };
        // `dirty` too: a find has never been written, so accepting it is exactly
        // what puts it in the upsert.
        holds[hold.id] = { ...hold, review: 'accepted', dirty: true };
      }
      return holds ? { ...state, holds } : state;
    }

    case 'KEEP_MAYBES': {
      let holds: Record<number, SprayEditorHold> | null = null;
      for (const hold of Object.values(state.holds)) {
        if (holdRole(hold) !== 'maybe') continue;
        holds ??= { ...state.holds };
        holds[hold.id] = { ...hold, review: 'accepted', dirty: true };
      }
      return holds ? commit(state, { ...snapshotOf(state), holds }) : state;
    }

    case 'MARK_REMOVED': {
      if (state.removedIds.length === 0) return state;
      // The removals have LANDED, so they leave the undo stack with them. Without
      // this, undoing past a join whose upsert then failed would restore the
      // victim as a live hold — and the next commit would name an id the server
      // has already stamped off, which is refused for the whole batch. The redo
      // future is scrubbed the same way, or a Redo could bring one back too.
      // History is rewritten rather than cleared: everything else in the session
      // is still undoable.
      const spent = new Set(state.removedIds);
      const scrub = (present: SprayEditorPresent): SprayEditorPresent => {
        const holds: Record<number, SprayEditorHold> = {};
        for (const hold of Object.values(present.holds)) {
          if (!spent.has(hold.id)) holds[hold.id] = hold;
        }
        return {
          holds,
          removedIds: present.removedIds.filter((id) => !spent.has(id)),
          selectedId: present.selectedId != null && spent.has(present.selectedId) ? null : present.selectedId,
          nextLocalId: present.nextLocalId,
        };
      };
      return {
        ...state,
        ...scrub(snapshotOf(state)),
        past: state.past.map(scrub),
        future: state.future.map(scrub),
      };
    }

    case 'MARK_SAVED': {
      const written = new Set(action.writtenIds);
      const holds: Record<number, SprayEditorHold> = {};
      let changed = state.removedIds.length > 0;
      for (const hold of Object.values(state.holds)) {
        const clears = hold.dirty && written.has(hold.id);
        holds[hold.id] = clears ? { ...hold, dirty: false } : hold;
        if (clears) changed = true;
      }
      if (!changed) return state;
      return { ...state, holds, removedIds: [], past: [], future: [] };
    }

    case 'UNDO': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        ...previous,
        past: state.past.slice(0, -1),
        future: capHistory([...state.future, snapshotOf(state)]),
      };
    }

    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        ...next,
        past: capHistory([...state.past, snapshotOf(state)]),
        future: state.future.slice(0, -1),
      };
    }

    default:
      return state;
  }
}

/**
 * Would `action` put a step on the undo stack — that is, change the wall?
 *
 * The screen raises its undo toast only when this holds, so a refused join or
 * a Keep all maybes with nothing to keep never leaves an Undo that would take
 * back the edit before it. Anything that leaves `past` alone (a selection, a
 * refused edit) returns false; the toast's take-down rule leans on the same
 * identity check, so a selection never takes the toast down either.
 */
export function actionChangesWall(state: SprayEditorState, action: SprayEditorAction): boolean {
  return sprayEditorReducer(state, action).past !== state.past;
}

// ---------------------------------------------------------------------------
// Selectors. Every one of these is called from a `useMemo` in the screen, so
// they are pure and take the state rather than reading it out of a closure.
// ---------------------------------------------------------------------------

/** How a hold reads on the wall. */
export type SprayHoldRole = 'on' | 'maybe' | 'off';

/**
 * ON, MAYBE or OFF.
 *
 * A pending find is ON when the detector was confident (`SPRAY_ON_CUTOFF`) and a
 * MAYBE otherwise. Finds below the maybe floor never reach the editor at all —
 * the seed drops them (`spray-hold-seed.ts`).
 */
export function holdRole(hold: SprayEditorHold): SprayHoldRole {
  if (hold.review === 'accepted') return 'on';
  if (hold.review === 'rejected') return 'off';
  return (hold.confidence ?? 0) >= SPRAY_ON_CUTOFF ? 'on' : 'maybe';
}

/**
 * Every hold, in id order so the SVG layer's path buckets are stable across
 * renders.
 *
 * Takes the RECORD rather than the state, so a caller can memoise on
 * `state.holds` — which only changes when a hold does. Memoising on `state`
 * instead would re-sort 1500 holds on every selection tap.
 */
export function holdsInIdOrder(holds: Readonly<Record<number, SprayEditorHold>>): SprayEditorHold[] {
  return Object.values(holds).sort((left, right) => left.id - right.id);
}

/** {@link holdsInIdOrder} against a whole state. */
export function allHolds(state: SprayEditorPresent): SprayEditorHold[] {
  return holdsInIdOrder(state.holds);
}

export type SprayEditorCounts = {
  /** Holds that would be on the wall if it published right now. */
  on: number;
  /** Dashed finds nobody has ruled on. */
  maybes: number;
  /** Rings switched off. */
  off: number;
  /** Accepted holds queued for `upsertSprayWallHolds`. */
  unsavedWrites: number;
  /**
   * Confident detector finds still pending: ON on screen, written by the next
   * commit, and on no server yet. Leaving loses them — a resumed draft does not
   * re-run detection.
   */
  unsavedFinds: number;
  /** Holds queued for `removeSprayWallHolds`. */
  unsavedRemovals: number;
};

/**
 * Count the wall, taking only the two things the count actually reads.
 *
 * Narrower than `SprayEditorState` on purpose: a caller memoising on the whole
 * state re-runs this O(n) loop on every selection tap, which cannot change a
 * count, and a wall may carry 1500 holds.
 */
export function countEditorHolds(
  holds: Readonly<Record<number, SprayEditorHold>>,
  removedCount: number,
): SprayEditorCounts {
  let on = 0;
  let maybes = 0;
  let off = 0;
  let unsavedWrites = 0;
  let unsavedFinds = 0;
  for (const hold of Object.values(holds)) {
    const role = holdRole(hold);
    if (role === 'on') {
      on += 1;
      if (hold.review === 'accepted' && hold.dirty) unsavedWrites += 1;
      else if (hold.review === 'pending') unsavedFinds += 1;
    } else if (role === 'maybe') {
      maybes += 1;
    } else {
      off += 1;
    }
  }
  return { on, maybes, off, unsavedWrites, unsavedFinds, unsavedRemovals: removedCount };
}

/** {@link countEditorHolds} against a whole state. */
export function editorCounts(state: SprayEditorState): SprayEditorCounts {
  return countEditorHolds(state.holds, state.removedIds.length);
}

/**
 * Has the climber changed anything a leave would throw away?
 *
 * Any undoable step counts, not just dirty holds: switching a confident find
 * off writes nothing and dirties nothing, but it is still a decision that
 * leaving would lose. So do confident finds nobody has touched: they are ON
 * and unsaved, and nothing re-detects them when the draft is resumed.
 */
export function editorIsDirty(state: SprayEditorState, counts: SprayEditorCounts): boolean {
  return state.past.length > 0 || counts.unsavedWrites > 0 || counts.unsavedFinds > 0 || counts.unsavedRemovals > 0;
}
