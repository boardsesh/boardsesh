import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import {
  actionChangesWall,
  allHolds,
  editorCounts,
  editorIsDirty,
  HISTORY_LIMIT,
  holdRole,
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorHold,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { SPRAY_MAYBE_FLOOR, SPRAY_ON_CUTOFF } from '../spray-hold-tools';
import { buildSprayHoldWritePlan } from '../spray-hold-writes';
import { holdsToCarryOver } from '../spray-hold-seed';

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

const CONFIDENT = SPRAY_ON_CUTOFF + 0.1;
const UNSURE = (SPRAY_ON_CUTOFF + SPRAY_MAYBE_FLOOR) / 2;

function run(state: SprayEditorState, ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, state);
}

function loaded(holds: SprayEditorHold[]): SprayEditorState {
  return sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds });
}

function isDirty(state: SprayEditorState): boolean {
  return editorIsDirty(state, editorCounts(state));
}

describe('holdRole', () => {
  it('reads a confident find as ON and an unsure one as a maybe', () => {
    expect(holdRole(candidate(-1, CONFIDENT))).toBe('on');
    expect(holdRole(candidate(-1, SPRAY_ON_CUTOFF))).toBe('on');
    expect(holdRole(candidate(-1, UNSURE))).toBe('maybe');
  });

  it('lets the climber overrule the detector either way', () => {
    expect(holdRole({ ...candidate(-1, UNSURE), review: 'accepted' })).toBe('on');
    expect(holdRole({ ...candidate(-1, CONFIDENT), review: 'rejected' })).toBe('off');
    expect(holdRole(storedHold(1))).toBe('on');
  });
});

describe('sprayEditorReducer', () => {
  it('LOAD establishes a baseline with no history to undo into', () => {
    const state = run(loaded([storedHold(1)]), { type: 'DELETE', id: 1 }, { type: 'LOAD', holds: [storedHold(2)] });
    expect(state.past).toHaveLength(0);
    expect(state.removedIds).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(allHolds(state).map((hold) => hold.id)).toEqual([2]);
  });

  it('ADD_HOLD mints local ids below every id it was given, and does not select', () => {
    const state = loaded([storedHold(1), candidate(-4, CONFIDENT)]);
    const added = sprayEditorReducer(state, { type: 'ADD_HOLD', geometry: { cx: 1, cy: 2, r: 3, outline: null } });
    expect(added.holds[-5]).toMatchObject({ source: 'MANUAL', review: 'accepted', dirty: true });
    expect(added.selectedId).toBeNull();
    const twice = sprayEditorReducer(added, { type: 'ADD_HOLD', geometry: { cx: 4, cy: 5, r: 6, outline: null } });
    expect(twice.holds[-6]).toBeDefined();
  });

  it('UNDO after a run of ADD_HOLDs takes the holds back one at a time, newest first', () => {
    const outline = [1, 0, 0, 1, -1, 0, 1, 0];
    const added = run(
      loaded([storedHold(1)]),
      { type: 'ADD_HOLD', geometry: { cx: 1, cy: 2, r: 3, outline: null } },
      { type: 'ADD_HOLD', geometry: { cx: 4, cy: 5, r: 6, outline } },
    );
    const once = sprayEditorReducer(added, { type: 'UNDO' });
    expect(once.holds[-2]).toBeUndefined();
    expect(once.holds[-1]).toBeDefined();
    const twice = sprayEditorReducer(once, { type: 'UNDO' });
    expect(twice.holds[-1]).toBeUndefined();
    expect(allHolds(twice).map((hold) => hold.id)).toEqual([1]);
  });

  describe('TOGGLE_HOLD', () => {
    it('switches a confident find OFF, writes nothing, and undoes back ON', () => {
      const state = run(loaded([candidate(-1, CONFIDENT)]), { type: 'TOGGLE_HOLD', id: -1 });
      expect(state.holds[-1].review).toBe('rejected');
      expect(holdRole(state.holds[-1])).toBe('off');
      expect(state.holds[-1].dirty).toBe(false);
      expect(state.removedIds).toEqual([]);
      expect(editorCounts(state)).toMatchObject({ on: 0, off: 1, unsavedWrites: 0 });

      const undone = sprayEditorReducer(state, { type: 'UNDO' });
      expect(holdRole(undone.holds[-1])).toBe('on');
      expect(undone.holds[-1].review).toBe('pending');
    });

    it('switches a maybe ON, marked for the upsert, and undoes back to a maybe', () => {
      const state = run(loaded([candidate(-1, UNSURE)]), { type: 'TOGGLE_HOLD', id: -1 });
      expect(state.holds[-1]).toMatchObject({ review: 'accepted', dirty: true });
      expect(editorCounts(state)).toMatchObject({ on: 1, maybes: 0, unsavedWrites: 1 });

      const undone = sprayEditorReducer(state, { type: 'UNDO' });
      expect(holdRole(undone.holds[-1])).toBe('maybe');
    });

    it('switches a rejected find back ON, and undo puts it back OFF', () => {
      const off = run(loaded([candidate(-1, CONFIDENT)]), { type: 'TOGGLE_HOLD', id: -1 });
      const on = sprayEditorReducer(off, { type: 'TOGGLE_HOLD', id: -1 });
      expect(on.holds[-1]).toMatchObject({ review: 'accepted', dirty: true });
      expect(holdRole(sprayEditorReducer(on, { type: 'UNDO' }).holds[-1])).toBe('off');
    });

    it('leaves a hand-placed local hold as a ghost that is never written, and undo brings it back ON', () => {
      const added = run(loaded([]), { type: 'ADD_HOLD', geometry: { cx: 10, cy: 10, r: 5, outline: null } });
      const localId = Object.values(added.holds)[0].id;
      const ghosted = sprayEditorReducer(added, { type: 'TOGGLE_HOLD', id: localId });
      // Still on the photo, switched off — a tap never makes a hold vanish.
      expect(ghosted.holds[localId]).toMatchObject({ review: 'rejected' });
      expect(holdRole(ghosted.holds[localId])).toBe('off');
      expect(ghosted.removedIds).toEqual([]);
      const plan = buildSprayHoldWritePlan(ghosted, IDENTITY_HOMOGRAPHY);
      expect(plan.upsert).toHaveLength(0);
      expect(plan.removeIds).toEqual([]);
      expect(holdsToCarryOver(allHolds(ghosted))).toEqual([]);
      expect(holdRole(sprayEditorReducer(ghosted, { type: 'UNDO' }).holds[localId])).toBe('on');
    });

    it('switches a hand-placed ghost back ON with a third tap', () => {
      const added = run(loaded([]), { type: 'ADD_HOLD', geometry: { cx: 10, cy: 10, r: 5, outline: null } });
      const localId = Object.values(added.holds)[0].id;
      const back = run(added, { type: 'TOGGLE_HOLD', id: localId }, { type: 'TOGGLE_HOLD', id: localId });
      expect(back.holds[localId]).toMatchObject({ review: 'accepted', dirty: true });
    });

    it('switches a stored hold OFF and queues its removal; switching it back takes it off the queue', () => {
      const off = run(loaded([storedHold(7)]), { type: 'TOGGLE_HOLD', id: 7 });
      expect(off.holds[7].review).toBe('rejected');
      expect(off.removedIds).toEqual([7]);

      const on = sprayEditorReducer(off, { type: 'TOGGLE_HOLD', id: 7 });
      expect(on.holds[7].review).toBe('accepted');
      expect(on.removedIds).toEqual([]);
      // Nothing about the hold changed, so it is not re-sent as a correction.
      expect(on.holds[7].dirty).toBe(false);

      const undone = sprayEditorReducer(off, { type: 'UNDO' });
      expect(undone.removedIds).toEqual([]);
      expect(undone.holds[7].review).toBe('accepted');
    });

    it('MARK_REMOVED scrubs a switched-off stored hold from the present and the history', () => {
      const state = run(
        loaded([storedHold(7), storedHold(8)]),
        { type: 'TOGGLE_HOLD', id: 7 },
        { type: 'MOVE_HOLD', id: 8, cx: 1, cy: 1 },
        { type: 'MARK_REMOVED' },
      );
      expect(state.holds[7]).toBeUndefined();
      expect(state.removedIds).toEqual([]);
      const undone = run(state, { type: 'UNDO' }, { type: 'UNDO' });
      expect(undone.holds[7]).toBeUndefined();
      expect(undone.holds[8].cx).toBe(800);
    });
  });

  describe('SWITCH_OFF', () => {
    it('switches a maybe OFF as a ghost, and undo makes it a maybe again', () => {
      const state = run(loaded([candidate(-1, UNSURE)]), { type: 'SWITCH_OFF', id: -1 });
      expect(holdRole(state.holds[-1])).toBe('off');
      expect(state.removedIds).toEqual([]);
      expect(holdRole(sprayEditorReducer(state, { type: 'UNDO' }).holds[-1])).toBe('maybe');
    });

    it('switches a stored hold OFF and queues its removal', () => {
      const state = run(loaded([storedHold(7)]), { type: 'SWITCH_OFF', id: 7 });
      expect(state.holds[7].review).toBe('rejected');
      expect(state.removedIds).toEqual([7]);
    });

    it('is identity on a ghost or a hold that is not there', () => {
      const off = run(loaded([storedHold(7)]), { type: 'SWITCH_OFF', id: 7 });
      expect(sprayEditorReducer(off, { type: 'SWITCH_OFF', id: 7 })).toBe(off);
      expect(sprayEditorReducer(off, { type: 'SWITCH_OFF', id: 99 })).toBe(off);
    });
  });

  it('SELECT is single-select, never history, and refuses a hold that is not there', () => {
    const state = run(loaded([storedHold(1), storedHold(2)]), { type: 'SELECT', id: 1 }, { type: 'SELECT', id: 2 });
    expect(state.selectedId).toBe(2);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(sprayEditorReducer(state, { type: 'SELECT', id: 2 })).toBe(state);
    expect(sprayEditorReducer(state, { type: 'SELECT', id: 99 }).selectedId).toBeNull();
    expect(sprayEditorReducer(state, { type: 'SELECT', id: null }).selectedId).toBeNull();
  });

  it('DELETE clears the selection and queues a stored hold for removal', () => {
    const state = run(loaded([storedHold(7)]), { type: 'SELECT', id: 7 }, { type: 'DELETE', id: 7 });
    expect(state.selectedId).toBeNull();
    expect(state.removedIds).toEqual([7]);
    expect(allHolds(state)).toHaveLength(0);
    expect(sprayEditorReducer(state, { type: 'DELETE', id: 7 })).toBe(state);
  });

  it('DELETE drops a local hold outright', () => {
    const state = run(loaded([candidate(-1, CONFIDENT)]), { type: 'DELETE', id: -1 });
    expect(state.removedIds).toEqual([]);
    expect(allHolds(state)).toHaveLength(0);
  });

  it('MERGE keeps the stored hold as the survivor, clears the selection, and turns it ON', () => {
    const state = run(
      loaded([storedHold(5, { cx: 100, cy: 100, r: 20 }), candidate(-1, UNSURE)]),
      { type: 'SELECT', id: -1 },
      { type: 'MERGE', ids: [-1, 5] },
    );
    expect(Object.keys(state.holds)).toEqual(['5']);
    expect(state.selectedId).toBeNull();
    expect(state.holds[5]).toMatchObject({ source: 'MANUAL', review: 'accepted', dirty: true, confidence: null });
    expect(state.removedIds).toEqual([]);
  });

  it('MERGE into a switched-off stored hold takes it back off the removal queue', () => {
    const state = run(
      loaded([storedHold(5, { cx: 100, cy: 100 }), storedHold(6, { cx: 130, cy: 100 })]),
      { type: 'TOGGLE_HOLD', id: 5 },
      { type: 'MERGE', ids: [5, 6] },
    );
    expect(state.removedIds).toEqual([6]);
    expect(state.holds[5].review).toBe('accepted');
  });

  it('MERGE needs exactly two distinct live holds', () => {
    const state = loaded([storedHold(5), storedHold(6)]);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5] })).toBe(state);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5, 5] })).toBe(state);
    expect(sprayEditorReducer(state, { type: 'MERGE', ids: [5, 99] })).toBe(state);
  });

  it('editing a switched-off hold turns it back ON', () => {
    const state = run(loaded([storedHold(3)]), { type: 'TOGGLE_HOLD', id: 3 }, { type: 'RESIZE_HOLD', id: 3, r: 40 });
    expect(state.holds[3]).toMatchObject({ review: 'accepted', dirty: true, r: 40 });
    expect(state.removedIds).toEqual([]);
  });

  it('MOVE and RESIZE mark the hold dirty and are no-ops when nothing changes', () => {
    const state = run(loaded([storedHold(3)]), { type: 'MOVE_HOLD', id: 3, cx: 11, cy: 12 });
    expect(state.holds[3]).toMatchObject({ cx: 11, cy: 12, dirty: true });
    expect(sprayEditorReducer(state, { type: 'MOVE_HOLD', id: 3, cx: 11, cy: 12 })).toBe(state);
    const resized = sprayEditorReducer(state, { type: 'RESIZE_HOLD', id: 3, r: 40 });
    expect(resized.holds[3].r).toBe(40);
    expect(sprayEditorReducer(resized, { type: 'RESIZE_HOLD', id: 3, r: 0 })).toBe(resized);
  });

  describe('ACCEPT_DEFAULTS', () => {
    it('accepts the confident pending finds only — not maybes, not switched-off ones', () => {
      const state = run(
        loaded([candidate(-1, CONFIDENT), candidate(-2, UNSURE), candidate(-3, CONFIDENT), storedHold(4)]),
        { type: 'TOGGLE_HOLD', id: -3 },
        { type: 'ACCEPT_DEFAULTS' },
      );
      expect(state.holds[-1]).toMatchObject({ review: 'accepted', dirty: true });
      expect(state.holds[-2].review).toBe('pending');
      expect(state.holds[-3].review).toBe('rejected');
      expect(state.holds[4]).toMatchObject({ review: 'accepted', dirty: false });
    });

    it('records no history and is identity when there is nothing to accept', () => {
      const base = loaded([candidate(-1, CONFIDENT)]);
      const accepted = sprayEditorReducer(base, { type: 'ACCEPT_DEFAULTS' });
      expect(accepted.past).toHaveLength(0);
      expect(sprayEditorReducer(accepted, { type: 'ACCEPT_DEFAULTS' })).toBe(accepted);
    });
  });

  it('KEEP_MAYBES turns every maybe ON as one undoable step', () => {
    const state = run(loaded([candidate(-1, UNSURE), candidate(-2, UNSURE), candidate(-3, CONFIDENT)]), {
      type: 'KEEP_MAYBES',
    });
    expect(editorCounts(state)).toMatchObject({ on: 3, maybes: 0, unsavedWrites: 2 });
    expect(editorCounts(sprayEditorReducer(state, { type: 'UNDO' }))).toMatchObject({ on: 1, maybes: 2 });
  });

  it('START_OVER goes back to the seed as one undoable step', () => {
    const seed = [storedHold(1), candidate(-1, CONFIDENT)];
    const edited = run(
      loaded(seed),
      { type: 'TOGGLE_HOLD', id: -1 },
      { type: 'DELETE', id: 1 },
      { type: 'ADD_HOLD', geometry: { cx: 1, cy: 1, r: 4, outline: null } },
    );
    const reset = sprayEditorReducer(edited, { type: 'START_OVER', holds: seed });
    expect(allHolds(reset).map((hold) => hold.id)).toEqual([-1, 1]);
    expect(reset.removedIds).toEqual([]);
    // Ids minted after starting over cannot collide with any the undo stack holds.
    expect(reset.nextLocalId).toBeLessThanOrEqual(edited.nextLocalId);
    expect(sprayEditorReducer(reset, { type: 'UNDO' })).toMatchObject({ holds: edited.holds });
  });

  it('MARK_SAVED clears the written flags, the removal list and the history', () => {
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'DELETE', id: 2 },
    );
    const saved = sprayEditorReducer(state, { type: 'MARK_SAVED', writtenIds: [1] });
    expect(saved.holds[1]).toMatchObject({ cx: 9, cy: 9, dirty: false });
    expect(saved.removedIds).toEqual([]);
    // Undoing into a pre-write snapshot would let the next commit write again.
    expect(saved.past).toHaveLength(0);
    expect(saved.future).toHaveLength(0);
    expect(sprayEditorReducer(saved, { type: 'MARK_SAVED', writtenIds: [1] })).toBe(saved);
  });

  it('MARK_SAVED leaves a hold the save left OUT still dirty', () => {
    const state = run(
      loaded([storedHold(1), storedHold(2)]),
      { type: 'MOVE_HOLD', id: 1, cx: 9, cy: 9 },
      { type: 'MOVE_HOLD', id: 2, cx: 8, cy: 8 },
    );
    const saved = sprayEditorReducer(state, { type: 'MARK_SAVED', writtenIds: [1] });
    expect(saved.holds[1].dirty).toBe(false);
    expect(saved.holds[2].dirty).toBe(true);
  });

  describe('dirty', () => {
    it('is dirty on a fresh detection load, because nothing re-detects the confident finds', () => {
      const state = loaded([candidate(-1, CONFIDENT), candidate(-2, UNSURE)]);
      expect(editorCounts(state)).toMatchObject({ unsavedFinds: 1 });
      expect(isDirty(state)).toBe(true);
    });

    it('is clean on a load with only maybes or stored holds', () => {
      expect(isDirty(loaded([candidate(-2, UNSURE)]))).toBe(false);
      expect(isDirty(loaded([storedHold(1), storedHold(2)]))).toBe(false);
    });

    it('is dirty after any decision, including one that writes nothing', () => {
      expect(isDirty(run(loaded([storedHold(1)]), { type: 'TOGGLE_HOLD', id: 1 }))).toBe(true);
    });

    it('is clean again once the decision is undone', () => {
      const state = run(loaded([storedHold(1)]), { type: 'TOGGLE_HOLD', id: 1 }, { type: 'UNDO' });
      expect(isDirty(state)).toBe(false);
    });

    it('is clean once the finds are saved', () => {
      const state = run(
        loaded([candidate(-1, CONFIDENT)]),
        { type: 'ACCEPT_DEFAULTS' },
        { type: 'MARK_SAVED', writtenIds: [-1] },
      );
      expect(isDirty(state)).toBe(false);
    });
  });

  describe('undo', () => {
    it('undoes twice through a join and a remove', () => {
      const base = loaded([storedHold(1, { cx: 100, cy: 100 }), storedHold(2, { cx: 130, cy: 100 }), storedHold(3)]);
      const edited = run(base, { type: 'MERGE', ids: [1, 2] }, { type: 'DELETE', id: 3 });
      expect(Object.keys(edited.holds)).toEqual(['1']);

      const onceBack = sprayEditorReducer(edited, { type: 'UNDO' });
      expect(Object.keys(onceBack.holds).sort()).toEqual(['1', '3']);
      expect(onceBack.removedIds).toEqual([2]);

      const twiceBack = sprayEditorReducer(onceBack, { type: 'UNDO' });
      expect(Object.keys(twiceBack.holds).sort()).toEqual(['1', '2', '3']);
      expect(twiceBack.removedIds).toEqual([]);
      expect(twiceBack.holds[1]).toBe(base.holds[1]);
    });

    it('undo restores the hold object itself, not a copy of its numbers', () => {
      const base = loaded([storedHold(4)]);
      const moved = sprayEditorReducer(base, { type: 'MOVE_HOLD', id: 4, cx: 1, cy: 1 });
      expect(sprayEditorReducer(moved, { type: 'UNDO' }).holds).toBe(base.holds);
    });

    it('undo at the bottom of the stack is identity', () => {
      const base = loaded([storedHold(1)]);
      expect(sprayEditorReducer(base, { type: 'UNDO' })).toBe(base);
    });

    it('history is capped, so a long session cannot grow without bound', () => {
      let state = loaded([storedHold(1)]);
      for (let step = 1; step <= HISTORY_LIMIT + 20; step += 1) {
        state = sprayEditorReducer(state, { type: 'MOVE_HOLD', id: 1, cx: step, cy: step });
      }
      expect(state.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
      expect(sprayEditorReducer(state, { type: 'UNDO' }).holds[1].cx).toBe(HISTORY_LIMIT + 19);
    });
  });

  describe('redo', () => {
    const base = () =>
      loaded([storedHold(1, { cx: 100, cy: 100 }), storedHold(2, { cx: 130, cy: 100 }), storedHold(3)]);

    it('round trips: redo after undo restores the very present the undo left', () => {
      const edited = run(base(), { type: 'MERGE', ids: [1, 2] }, { type: 'DELETE', id: 3 });
      const undone = run(edited, { type: 'UNDO' }, { type: 'UNDO' });
      expect(undone.future).toHaveLength(2);
      const once = sprayEditorReducer(undone, { type: 'REDO' });
      expect(Object.keys(once.holds).sort()).toEqual(['1', '3']);
      expect(once.removedIds).toEqual([2]);
      const twice = sprayEditorReducer(once, { type: 'REDO' });
      expect(twice.holds).toBe(edited.holds);
      expect(twice.removedIds).toBe(edited.removedIds);
      expect(twice.past).toHaveLength(2);
      expect(twice.future).toHaveLength(0);
    });

    it('undo and redo interleave without losing a step', () => {
      const edited = run(
        base(),
        { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 },
        { type: 'MOVE_HOLD', id: 1, cx: 6, cy: 6 },
      );
      const state = run(
        edited,
        { type: 'UNDO' },
        { type: 'UNDO' },
        { type: 'REDO' },
        { type: 'UNDO' },
        { type: 'REDO' },
      );
      expect(state.holds[1].cx).toBe(5);
      expect(sprayEditorReducer(state, { type: 'REDO' }).holds[1].cx).toBe(6);
    });

    it('redo with nothing to bring back is identity', () => {
      const state = base();
      expect(sprayEditorReducer(state, { type: 'REDO' })).toBe(state);
    });

    it('a new edit after an undo clears the future', () => {
      const undone = run(base(), { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 }, { type: 'UNDO' });
      expect(undone.future).toHaveLength(1);
      const edited = sprayEditorReducer(undone, { type: 'TOGGLE_HOLD', id: 3 });
      expect(edited.future).toHaveLength(0);
      expect(sprayEditorReducer(edited, { type: 'REDO' })).toBe(edited);
    });

    it('SELECT leaves the future alone', () => {
      const undone = run(base(), { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 }, { type: 'UNDO' });
      const selected = sprayEditorReducer(undone, { type: 'SELECT', id: 2 });
      expect(selected.future).toBe(undone.future);
      expect(sprayEditorReducer(selected, { type: 'REDO' }).holds[1].cx).toBe(5);
    });

    it('LOAD and MARK_SAVED clear the future', () => {
      const undone = run(
        base(),
        { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 },
        { type: 'MOVE_HOLD', id: 2, cx: 7, cy: 7 },
        {
          type: 'UNDO',
        },
      );
      expect(undone.future).toHaveLength(1);
      expect(sprayEditorReducer(undone, { type: 'LOAD', holds: [storedHold(1)] }).future).toHaveLength(0);
      expect(sprayEditorReducer(undone, { type: 'MARK_SAVED', writtenIds: [1] }).future).toHaveLength(0);
    });

    it('MARK_REMOVED scrubs the future, so redo cannot bring back a hold the server took off', () => {
      // Hold 3 is switched off, then the undo of a later move parks a snapshot
      // that still names it in the future. Its removal lands; redo must not
      // resurrect it or queue it a second time.
      const parked = run(
        base(),
        { type: 'TOGGLE_HOLD', id: 3 },
        { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 },
        { type: 'UNDO' },
      );
      const landed = sprayEditorReducer(parked, { type: 'MARK_REMOVED' });
      expect(landed.future).toHaveLength(1);
      const redone = sprayEditorReducer(landed, { type: 'REDO' });
      expect(redone.holds[3]).toBeUndefined();
      expect(redone.removedIds).toEqual([]);
      expect(redone.holds[1].cx).toBe(5);
    });

    it('the future is capped like the past', () => {
      let state = loaded([storedHold(1)]);
      for (let step = 1; step <= HISTORY_LIMIT + 5; step += 1) {
        state = sprayEditorReducer(state, { type: 'MOVE_HOLD', id: 1, cx: step, cy: step });
      }
      for (let step = 0; step < HISTORY_LIMIT + 5; step += 1) state = sprayEditorReducer(state, { type: 'UNDO' });
      expect(state.future.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    });
  });

  it('counts a 100-hold wall correctly end to end', () => {
    const wall = Array.from({ length: 100 }, (_, index) => storedHold(index + 1));
    const state = run(
      loaded([...wall, candidate(-1, CONFIDENT), candidate(-2, UNSURE)]),
      ...Array.from({ length: 5 }, (_, index): SprayEditorAction => ({
        type: 'ADD_HOLD',
        geometry: { cx: index * 10, cy: 900, r: 12, outline: null },
      })),
      { type: 'MOVE_HOLD', id: 1, cx: 5, cy: 5 },
      { type: 'RESIZE_HOLD', id: 4, r: 30 },
      { type: 'TOGGLE_HOLD', id: 10 },
      { type: 'TOGGLE_HOLD', id: 11 },
      { type: 'MERGE', ids: [20, 21] },
      { type: 'UNDO' },
    );
    // 100 stored + 1 confident find + 5 added, two switched off; the join undone.
    expect(editorCounts(state)).toMatchObject({ on: 104, maybes: 1, off: 2, unsavedWrites: 7, unsavedRemovals: 2 });
  });
});

// The undo toast's two rules: raise only when the edit changed the wall, and
// come down the moment `past` moves again. Both read `past` identity.
describe('actionChangesWall', () => {
  const wall = () => loaded([storedHold(1), storedHold(2), candidate(-1, UNSURE)]);

  it('is false for a refused join, so no Undo can take back the edit before it', () => {
    const edited = sprayEditorReducer(wall(), { type: 'DELETE', id: 2 });
    expect(actionChangesWall(edited, { type: 'MERGE', ids: [1, 1] })).toBe(false);
    expect(actionChangesWall(edited, { type: 'MERGE', ids: [1, 2] })).toBe(false);
    expect(actionChangesWall(edited, { type: 'MERGE', ids: [1, -1] })).toBe(true);
  });

  it('is false for Keep all maybes with no maybe left to keep', () => {
    expect(actionChangesWall(wall(), { type: 'KEEP_MAYBES' })).toBe(true);
    const kept = sprayEditorReducer(wall(), { type: 'KEEP_MAYBES' });
    expect(actionChangesWall(kept, { type: 'KEEP_MAYBES' })).toBe(false);
  });

  it('is true for Start over, even on an untouched wall', () => {
    const seed = [storedHold(1), storedHold(2), candidate(-1, UNSURE)];
    expect(actionChangesWall(wall(), { type: 'START_OVER', holds: seed })).toBe(true);
  });

  it('is false for a selection, which leaves the toast standing', () => {
    const state = wall();
    expect(actionChangesWall(state, { type: 'SELECT', id: 1 })).toBe(false);
    expect(sprayEditorReducer(state, { type: 'SELECT', id: 1 }).past).toBe(state.past);
  });

  it('is true for the delete and the undo after it, so either takes the toast down', () => {
    const state = wall();
    expect(actionChangesWall(state, { type: 'DELETE', id: 1 })).toBe(true);
    const deleted = sprayEditorReducer(state, { type: 'DELETE', id: 1 });
    expect(actionChangesWall(deleted, { type: 'UNDO' })).toBe(true);
    expect(actionChangesWall(deleted, { type: 'DELETE', id: 2 })).toBe(true);
  });
});
