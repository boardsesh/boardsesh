import { describe, expect, it } from 'vitest';
import { holdsOnlyPreviewPath } from '../spray-holds-only-preview';
import {
  holdsInIdOrder,
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorHold,
} from '../spray-hold-editor-reducer';
import { holdPathData } from '../spray-hold-path';

function hold(id: number, overrides: Partial<SprayEditorHold> = {}): SprayEditorHold {
  return {
    id,
    cx: 100,
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

describe('holds-only preview geometry', () => {
  it('shows ON manual and confident detector holds, excluding maybes and switched-off holds', () => {
    const manual = hold(1);
    const confident = hold(-1, { source: 'AUTO', review: 'pending', confidence: 0.95, cx: 300 });
    const maybe = hold(-2, { source: 'AUTO', review: 'pending', confidence: 0.5, cx: 500 });
    const off = hold(2, { review: 'rejected', cx: 700 });
    expect(holdsOnlyPreviewPath([manual, confident, maybe, off])).toBe(holdPathData(manual) + holdPathData(confident));
    expect(holdsOnlyPreviewPath([])).toBe('');
  });

  it('uses local traced outlines immediately, then follows switch-off, undo and added holds', () => {
    const initial = sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds: [hold(1)] });
    const traced = sprayEditorReducer(initial, {
      type: 'SET_OUTLINE',
      id: 1,
      geometry: { cx: 100, cy: 200, r: 20, outline: [-1, -1, -1, 1, 1, 1, 1, -1, -1, -1] },
    });
    const preview = (state: typeof initial) => holdsOnlyPreviewPath(holdsInIdOrder(state.holds));
    const tracedPath = preview(traced);
    expect(tracedPath).toBe('M80 180L80 220L120 220L120 180L80 180Z');
    expect(traced.holds[1].dirty).toBe(true);
    expect(preview(initial)).not.toBe(tracedPath);
    const switchedOff = sprayEditorReducer(traced, { type: 'SWITCH_OFF', id: 1 });
    expect(preview(switchedOff)).toBe('');
    const undone = sprayEditorReducer(switchedOff, { type: 'UNDO' });
    expect(preview(undone)).toBe(tracedPath);
    const added = sprayEditorReducer(undone, {
      type: 'ADD_HOLD',
      geometry: { cx: 300, cy: 400, r: 10, outline: null },
    });
    expect(preview(added)).toContain(holdPathData(added.holds[-1]));
    // A preview reads the reducer; it never marks these local edits as saved.
    expect(added.holds[-1].dirty).toBe(true);
    expect(added.past.length).toBeGreaterThan(undone.past.length);
  });

  it('normalizes opposite traced directions so overlapping holds do not cancel', () => {
    const clockwise = [-1, -1, -1, 1, 1, 1, 1, -1, -1, -1];
    const counterclockwise = [-1, -1, 1, -1, 1, 1, -1, 1, -1, -1];
    const first = hold(1, { outline: clockwise });
    const second = hold(2, { outline: counterclockwise });
    const original = [...counterclockwise];
    expect(holdsOnlyPreviewPath([first, second])).toBe(holdPathData(first).repeat(2));
    expect(counterclockwise).toEqual(original);
  });

  it('previews kept Refine strokes before Done without showing an OFF hold', () => {
    const refined = { holdId: 1, outlineBoardPx: [10, 20, 10, 40, 50, 40, 50, 20, 10, 20] };
    expect(holdsOnlyPreviewPath([hold(1)], refined)).toBe('M10 20L10 40L50 40L50 20L10 20Z');
    expect(holdsOnlyPreviewPath([hold(1, { review: 'rejected' })], refined)).toBe('');
  });
});
