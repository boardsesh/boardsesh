import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import {
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorHold,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { planSprayPutBack, type SprayPutBackHold } from '../spray-put-back';

/**
 * What the hold editor does when a climb sends the owner to put a removed hold
 * back (#5493): add a new linked hold where the old one was, or pick the one an
 * earlier, unpublished trip already added.
 */

function hold(id: number, overrides: Partial<SprayEditorHold> = {}): SprayEditorHold {
  return {
    id,
    cx: 500,
    cy: 500,
    r: 20,
    outline: null,
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
    ...overrides,
  };
}

function loaded(holds: SprayEditorHold[]): SprayEditorState {
  return sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds });
}

const PUT_BACK: SprayPutBackHold = {
  removedHoldId: 42,
  knownSuccessorIds: [],
  cx: 300,
  cy: 400,
  r: 25,
  outline: null,
};

/** Photo px → canonical px at half scale, so canonical (300, 400) is photo (600, 800). */
const HALF_SCALE = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];

describe('planSprayPutBack', () => {
  it('adds a new hold at the mapped geometry, linked to the removed one and selected', () => {
    const state = loaded([hold(1)]);
    const plan = planSprayPutBack(state, PUT_BACK, HALF_SCALE);
    expect(plan?.action).toEqual({
      type: 'ADD_HOLD',
      geometry: { cx: 600, cy: 800, r: 50, outline: null },
      movedFromHoldId: 42,
      select: true,
    });
    const next = sprayEditorReducer(state, plan!.action);
    const added = next.holds[next.selectedId!];
    expect(added).toMatchObject({ cx: 600, cy: 800, r: 50, movedFromHoldId: 42, dirty: true, review: 'accepted' });
    expect(added.id).toBeLessThan(0);
    expect(plan?.focus).toEqual({ cx: 600, cy: 800, r: 50 });
  });

  it('selects a hold an earlier trip already put back instead of adding a second', () => {
    const state = loaded([hold(1), hold(9, { cx: 610, cy: 790, movedFromHoldId: 42 })]);
    const plan = planSprayPutBack(state, PUT_BACK, HALF_SCALE);
    expect(plan?.action).toEqual({ type: 'SELECT', id: 9 });
    expect(plan?.focus).toEqual({ cx: 610, cy: 790, r: 20 });
    expect(Object.keys(sprayEditorReducer(state, plan!.action).holds)).toHaveLength(2);
  });

  it('never reuses a successor that was linked before the trip', () => {
    const state = loaded([hold(9, { movedFromHoldId: 42 })]);
    const plan = planSprayPutBack(state, { ...PUT_BACK, knownSuccessorIds: [9] }, IDENTITY_HOMOGRAPHY);
    expect(plan?.action).toMatchObject({ type: 'ADD_HOLD', movedFromHoldId: 42 });
  });

  it('ignores a linked hold the owner switched off', () => {
    const state = loaded([hold(9, { movedFromHoldId: 42, review: 'rejected' })]);
    expect(planSprayPutBack(state, PUT_BACK, IDENTITY_HOMOGRAPHY)?.action.type).toBe('ADD_HOLD');
  });

  it('does nothing when the homography sends the hold nowhere', () => {
    expect(planSprayPutBack(loaded([]), PUT_BACK, [0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});
