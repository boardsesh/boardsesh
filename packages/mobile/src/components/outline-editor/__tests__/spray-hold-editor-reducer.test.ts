import { describe, expect, it } from 'vitest';
import {
  allHolds,
  DEFAULT_CONFIDENCE_THRESHOLD,
  editorCounts,
  hasUnsavedWork,
  HISTORY_LIMIT,
  initialSprayEditorState,
  isHiddenByThreshold,
  pendingCandidateIds,
  sprayEditorReducer,
  visibleHolds,
  type SprayEditorAction,
  type SprayEditorHold,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';

function storedHold(id: number, overrides: Partial<SprayEditorHold> = {}): SprayEditorHold {
  return {
    id,
    cx: id * 100,
    cy: 200,
    r: 20,
    outline: null,
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
    ...overrides,
  };
}

function candidate(id: number, confidence: number): SprayEditorHold {
  return storedHold(id, { source: 'AUTO', confidence, review: 'pending' });
}

function run(state: SprayEditorState, ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, state);
}

function loaded(holds: SprayEditorHold[]): SprayEditorState {
  return sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds });
}

describe('sprayEditorReducer', () => {
  it('LOAD establishes a baseline with no history to undo into', () => {
    const state = run(loaded([storedHold(1)]), { type: 'DELETE', ids: [1] }, { type: 'LOAD', holds: [storedHold(2)] });
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(state.removedIds).toEqual([]);
    expect(allHolds(state).map((hold) => hold.id)).toEqual([2]);
  });

  it('LOAD mints local ids below every id it was given', () => {
    const state = loaded([storedHold(1), storedHold(9)]);
    const added = sprayEditorReducer(state, { type: 'ADD_HOLD', geometry: { cx: 1, cy: 2, r: 3, outline: null } });
    expect(added.selectedIds).toEqual([-1]);
    expect(added.holds[-1].source).toBe('MANUAL');
    expect(added.holds[-1].dirty).toBe(true);
    // And the NEXT add does not collide with the first.
    const twice = sprayEditorReducer(added, { type: 'ADD_HOLD', geometry: { cx: 4, cy: 5, r: 6, outline: null } });
    expect(twice.selectedIds).toEqual([-2]);
    expect(Object.keys(twice.holds)).toHaveLength(4);
  });

  it('deleting a stored hold records it for removal; deleting a local one just drops it', () => {
    const state = run(
      loaded([storedHold(7)]),
      { type: 'ADD_HOLD', geometry: { cx: 1, cy: 1, r: 5, outline: null } },
      { type: 'DELETE', ids: [7, -1] },
    );
    expect(state.removedIds).toEqual([7]);
    expect(allHolds(state)).toHaveLength(0);
  });

  it('deleting the same stored hold twice records it once', () => {
    const first = run(loaded([storedHold(7)]), { type: 'DELETE', ids: [7] });
    const again = sprayEditorReducer(first, { type: 'DELETE', ids: [7] });
    expect(again).toBe(first);
    expect(first.removedIds).toEqual([7]);
  });

  it('MOVE and RESIZE mark the hold dirty and are no-ops when nothing changes', () => {
    const state = run(loaded([storedHold(3)]), { type: 'MOVE_HOLD', id: 3, cx: 11, cy: 12 });
    expect(state.holds[3]).toMatchObject({ cx: 11, cy: 12, dirty: true });

    const same = sprayEditorReducer(state, { type: 'MOVE_HOLD', id: 3, cx: 11, cy: 12 });
    expect(same).toBe(state);

    const resized = sprayEditorReducer(state, { type: 'RESIZE_HOLD', id: 3, r: 40 });
    expect(resized.holds[3].r).toBe(40);
    expect(sprayEditorReducer(resized, { type: 'RESIZE_HOLD', id: 3, r: 0 })).toBe(resized);
  });

  it('MERGE keeps the stored hold as the survivor and removes the other', () => {
    const state = run(
      loaded([storedHold(5, { cx: 100, cy: 100, r: 20 })]),
      { type: 'ADD_HOLD', geometry: { cx: 130, cy: 100, r: 20, outline: null } },
      { type: 'SELECT', ids: [-1, 5] },
      { type: 'MERGE', ids: [-1, 5] },
    );
    // 5 survives even though it was the SECOND id: a stored hold carries every
    // climb ever set on it, and a merge must not orphan them.
    expect(Object.keys(state.holds)).toEqual(['5']);
    expect(state.selectedIds).toEqual([5]);
    expect(state.holds[5].dirty).toBe(true);
    expect(state.holds[5].source).toBe('MANUAL');
    // The local victim was never on the wall, so there is nothing to remove.
    expect(state.removedIds).toEqual([]);
    // The union covers both originals.
    expect(state.holds[5].cx).toBeGreaterThan(100);
    expect(state.holds[5].cx).toBeLessThan(130);
  });

  it('MERGE of two stored holds removes the victim from the wall', () => {
    const state = run(loaded([storedHold(5, { cx: 100, cy: 100 }), storedHold(6, { cx: 130, cy: 100 })]), {
      type: 'MERGE',
      ids: [5, 6],
    });
    expect(state.removedIds).toEqual([6]);
    expect(Object.keys(state.holds)).toEqual(['5']);
  });

  it('MERGE needs exactly two distinct live holds', () => {
    const state = loaded([storedHold(5), storedHold(6)]);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5] })).toBe(state);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5, 5] })).toBe(state);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5, 99] })).toBe(state);
  });

  it('a pending candidate is not unsaved work until it is accepted', () => {
    const state = loaded([candidate(-1, 0.9)]);
    expect(hasUnsavedWork(state)).toBe(false);
    expect(editorCounts(state)).toMatchObject({ alive: 0, pending: 1, unsavedWrites: 0 });

    const accepted = sprayEditorReducer(state, { type: 'ACCEPT', ids: [-1] });
    expect(hasUnsavedWork(accepted)).toBe(true);
    expect(editorCounts(accepted)).toMatchObject({ alive: 1, pending: 0, unsavedWrites: 1 });
  });

  it('ACCEPT_ALL takes only the candidates at or above the threshold', () => {
    const state = run(
      loaded([candidate(-1, 0.9), candidate(-2, 0.5), candidate(-3, 0.2)]),
      { type: 'SET_THRESHOLD', threshold: 0.5 },
      { type: 'ACCEPT_ALL' },
    );
    expect(pendingCandidateIds(state)).toEqual([-3]);
    expect(editorCounts(state)).toMatchObject({ alive: 2, pending: 1, hidden: 1 });
  });

  it('ACCEPT_ALL is a no-op — and records no history — when everything is hidden', () => {
    const state = run(loaded([candidate(-1, 0.1)]), { type: 'SET_THRESHOLD', threshold: 0.9 });
    expect(sprayEditorReducer(state, { type: 'ACCEPT_ALL' })).toBe(state);
  });

  it('the threshold hides pending candidates only, never accepted holds', () => {
    const state = run(
      loaded([candidate(-1, 0.1)]),
      { type: 'ACCEPT', ids: [-1] },
      {
        type: 'SET_THRESHOLD',
        threshold: 0.9,
      },
    );
    expect(isHiddenByThreshold(state.holds[-1], 0.9)).toBe(false);
    expect(visibleHolds(state)).toHaveLength(1);
  });

  it('MARK_SAVED clears the dirty flags and the removal list without waiting for a refetch', () => {
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'DELETE', ids: [2] },
    );
    expect(hasUnsavedWork(state)).toBe(true);

    const saved = sprayEditorReducer(state, { type: 'MARK_SAVED', writtenIds: [1] });
    expect(hasUnsavedWork(saved)).toBe(false);
    expect(saved.removedIds).toEqual([]);
    // The hold is still where the climber moved it — only the "needs writing"
    // flag is gone.
    expect(saved.holds[1]).toMatchObject({ cx: 9, cy: 9, dirty: false });
    // A second press of Save must therefore send nothing at all.
    expect(sprayEditorReducer(saved, { type: 'MARK_SAVED', writtenIds: [1] })).toBe(saved);
  });

  it('MARK_SAVED leaves a hold the save left OUT still dirty', () => {
    // A plan can succeed while omitting holds — one the homography sends off the
    // wall, one drawn while the request was in flight — and the screen says so.
    // Clearing those too would let the next re-seed delete work the UI had just
    // promised was still there.
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'MOVE_HOLD', id: 2, cx: 8, cy: 8 },
    );
    const saved = sprayEditorReducer(state, { type: 'MARK_SAVED', writtenIds: [1] });
    expect(saved.holds[1].dirty).toBe(false);
    expect(saved.holds[2].dirty).toBe(true);
    expect(hasUnsavedWork(saved)).toBe(true);
  });

  it('MARK_REMOVED strips the removed holds from the undo stack too', () => {
    // The removal has LANDED. If the upsert then fails, undoing past the delete
    // must not restore the hold as a clean live one — the next save would name an
    // id the server has already stamped off, and the whole batch is refused.
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'DELETE', ids: [2] },
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'MARK_REMOVED' },
    );
    expect(state.removedIds).toEqual([]);

    const undoneTwice = run(state, { type: 'UNDO' }, { type: 'UNDO' });
    expect(Object.keys(undoneTwice.holds)).toEqual(['1']);
    expect(undoneTwice.removedIds).toEqual([]);

    // ...and redoing forward cannot bring it back either.
    const redone = run(undoneTwice, { type: 'REDO' }, { type: 'REDO' });
    expect(Object.keys(redone.holds)).toEqual(['1']);
  });

  it('MARK_REMOVED leaves everything else undoable', () => {
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'DELETE', ids: [2] },
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'MARK_REMOVED' },
      { type: 'UNDO' },
    );
    // Losing an hour of corrections because one hold came off would be its own
    // bug: history is rewritten, not cleared.
    expect(state.holds[1]).toMatchObject({ cx: 100, dirty: false });
  });

  it('the threshold drops a selection it has just hidden', () => {
    const state = run(
      loaded([candidate(-1, 0.2), storedHold(1)]),
      { type: 'SET_THRESHOLD', threshold: 0 },
      { type: 'SELECT', ids: [-1, 1] },
      { type: 'SET_THRESHOLD', threshold: 0.9 },
    );
    // Otherwise Delete would take a hold off the wall that is not on screen.
    expect(state.selectedIds).toEqual([1]);
  });

  it('the threshold clamps to 0..1 and starts at the detector default', () => {
    const state = loaded([]);
    expect(state.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(sprayEditorReducer(state, { type: 'SET_THRESHOLD', threshold: 5 }).threshold).toBe(1);
    expect(sprayEditorReducer(state, { type: 'SET_THRESHOLD', threshold: -5 }).threshold).toBe(0);
  });

  it('selection changes never record history', () => {
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'SELECT', ids: [1] },
      {
        type: 'TOGGLE_SELECT',
        id: 2,
      },
    );
    expect(state.selectedIds).toEqual([1, 2]);
    expect(state.past).toHaveLength(0);
    // Selecting the same thing again is identity, so React skips the render.
    expect(sprayEditorReducer(state, { type: 'SELECT', ids: [1, 2] })).toBe(state);
    // A hold that is not there cannot be selected.
    expect(sprayEditorReducer(state, { type: 'TOGGLE_SELECT', id: 99 })).toBe(state);
  });

  it('a threshold change is not undoable', () => {
    const state = run(loaded([candidate(-1, 0.9)]), { type: 'SET_THRESHOLD', threshold: 0.8 });
    expect(state.past).toHaveLength(0);
    expect(sprayEditorReducer(state, { type: 'UNDO' })).toBe(state);
  });

  describe('undo', () => {
    it('undoes twice through a merge and a delete, and redoes back', () => {
      const base = loaded([storedHold(1, { cx: 100, cy: 100 }), storedHold(2, { cx: 130, cy: 100 }), storedHold(3)]);
      const edited = run(base, { type: 'MERGE', ids: [1, 2] }, { type: 'DELETE', ids: [3] });
      expect(Object.keys(edited.holds)).toEqual(['1']);

      const onceBack = sprayEditorReducer(edited, { type: 'UNDO' });
      expect(Object.keys(onceBack.holds).sort()).toEqual(['1', '3']);
      expect(onceBack.removedIds).toEqual([2]);

      const twiceBack = sprayEditorReducer(onceBack, { type: 'UNDO' });
      expect(Object.keys(twiceBack.holds).sort()).toEqual(['1', '2', '3']);
      expect(twiceBack.removedIds).toEqual([]);
      expect(twiceBack.holds[1]).toBe(base.holds[1]);

      const redone = run(twiceBack, { type: 'REDO' }, { type: 'REDO' });
      expect(Object.keys(redone.holds)).toEqual(['1']);
      expect(redone.removedIds).toEqual([2, 3]);
    });

    it('undo restores the hold object itself, not a copy of its numbers', () => {
      const base = loaded([storedHold(4)]);
      const moved = sprayEditorReducer(base, { type: 'MOVE_HOLD', id: 4, cx: 1, cy: 1 });
      const undone = sprayEditorReducer(moved, { type: 'UNDO' });
      expect(undone.holds).toBe(base.holds);
      expect(undone.holds[4].dirty).toBe(false);
    });

    it('a new edit drops the redo stack', () => {
      const base = loaded([storedHold(1)]);
      const undone = run(base, { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 }, { type: 'UNDO' });
      expect(undone.future).toHaveLength(1);
      const diverged = sprayEditorReducer(undone, { type: 'RESIZE_HOLD', id: 1, r: 33 });
      expect(diverged.future).toHaveLength(0);
      expect(sprayEditorReducer(diverged, { type: 'REDO' })).toBe(diverged);
    });

    it('undo at the bottom of the stack is identity', () => {
      const base = loaded([storedHold(1)]);
      expect(sprayEditorReducer(base, { type: 'UNDO' })).toBe(base);
      expect(sprayEditorReducer(base, { type: 'REDO' })).toBe(base);
    });

    it('history is capped, so a long session cannot grow without bound', () => {
      let state = loaded([storedHold(1)]);
      for (let step = 1; step <= HISTORY_LIMIT + 20; step += 1) {
        state = sprayEditorReducer(state, { type: 'MOVE_HOLD', id: 1, cx: step, cy: step });
      }
      expect(state.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
      // And the cap does not break undo: it still walks back one step at a time.
      expect(sprayEditorReducer(state, { type: 'UNDO' }).holds[1].cx).toBe(HISTORY_LIMIT + 19);
    });
  });

  it('counts a 100-hold wall correctly end to end', () => {
    const wall = Array.from({ length: 100 }, (_, index) => storedHold(index + 1));
    const state = run(
      loaded(wall),
      ...Array.from({ length: 5 }, (_, index): SprayEditorAction => ({
        type: 'ADD_HOLD',
        geometry: { cx: index * 10, cy: 900, r: 12, outline: null },
      })),
      { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 },
      { type: 'MOVE_HOLD', id: 2, cx: 6, cy: 6 },
      { type: 'MOVE_HOLD', id: 3, cx: 7, cy: 7 },
      { type: 'RESIZE_HOLD', id: 4, r: 30 },
      { type: 'RESIZE_HOLD', id: 5, r: 30 },
      { type: 'DELETE', ids: [10, 11, 12, 13] },
      { type: 'MERGE', ids: [20, 21] },
      { type: 'UNDO' },
      { type: 'UNDO' },
    );
    // The merge and the delete are both undone: 100 stored + 5 added.
    expect(allHolds(state)).toHaveLength(105);
    expect(state.removedIds).toEqual([]);
    expect(editorCounts(state)).toMatchObject({ alive: 105, pending: 0, unsavedWrites: 10 });
  });
});
