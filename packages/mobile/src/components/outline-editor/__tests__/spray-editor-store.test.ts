import { describe, expect, it, vi } from 'vitest';
import { MAX_HOLDS_PER_WALL } from '@boardsesh/board-config';
import { holdAtPoint } from '../spray-hold-tools';
import { createSprayEditorStore } from '../spray-editor-store';
import { initialSprayEditorState, type SprayEditorHold } from '../spray-hold-editor-reducer';
const geometry = { cx: 10, cy: 20, r: 5, outline: null };
function hold(id: number): SprayEditorHold {
  return { ...geometry, id, source: 'MANUAL', confidence: null, review: 'accepted', dirty: false };
}
describe('synchronous editor transactions', () => {
  it('allocates unique ids and tracks the actual last addition before any render', () => {
    const store = createSprayEditorStore();
    const notify = vi.fn();
    store.subscribe(notify);
    store.dispatch({ type: 'ADD_HOLD', geometry, select: true });
    const second = store.dispatch({ type: 'ADD_HOLD', geometry: { ...geometry, cx: 30 }, select: true });
    expect(Object.keys(second.holds)).toHaveLength(2);
    expect(second.holds[-1].cx).toBe(10);
    expect(second.holds[-2].cx).toBe(30);
    expect(second.lastAddedId).toBe(-2);
    expect(second.selectedId).toBe(-2);
    expect(store.counts.on).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('accepts exactly one of two queued additions at max minus one', () => {
    const holds = Array.from({ length: MAX_HOLDS_PER_WALL - 1 }, (_, index) => hold(index + 1));
    const store = createSprayEditorStore(initialSprayEditorState(holds));
    const accepted = store.dispatch({ type: 'ADD_HOLD', geometry, select: true });
    const refused = store.dispatch({ type: 'ADD_HOLD', geometry, select: true });
    expect(refused).toBe(accepted);
    expect(store.counts.on).toBe(MAX_HOLDS_PER_WALL);
    expect(refused.nextLocalId).toBe(-2);
    expect(refused.lastAddedId).toBe(-1);
    expect(refused.selectedId).toBe(-1);
  });
  it('keeps transient handle focus out of undo and advances draft generations', () => {
    const store = createSprayEditorStore();
    store.dispatch({ type: 'ADD_HOLD', geometry });
    const history = store.current.past;
    store.dispatch({ type: 'CLEAR_ADD_FOCUS' });
    expect(store.current.past).toBe(history);
    expect(store.current.lastAddedId).toBeNull();
    const generation = store.generation;
    store.dispatch({ type: 'LOAD', holds: [hold(1)] });
    expect(store.generation).toBe(generation + 1);
    store.dispatch({ type: 'RESTORE', present: store.current });
    expect(store.generation).toBe(generation + 2);
  });
});

it('resolves consecutive Pencil contacts against the preceding committed hold and role', () => {
  const store = createSprayEditorStore();
  expect(holdAtPoint(store.getHitHolds(true).visible, 10, 20)).toBeNull();
  store.dispatch({ type: 'ADD_HOLD', geometry });
  const firstHit = holdAtPoint(store.getHitHolds(true).visible, 10, 20);
  expect(firstHit?.id).toBe(-1);
  store.dispatch({ type: 'TOGGLE_HOLD', id: -1 });
  const secondHit = holdAtPoint(store.getHitHolds(true).visible, 10, 20);
  expect(secondHit?.review).toBe('rejected');
  store.dispatch({ type: 'TOGGLE_HOLD', id: -1 });
  expect(holdAtPoint(store.getHitHolds(true).visible, 10, 20)?.review).toBe('accepted');
  expect(Object.keys(store.current.holds)).toHaveLength(1);
});
