import { describe, expect, it } from 'vitest';
import { revertedHold } from '../spray-spotlight';
import type { SprayEditorHold } from '../spray-hold-editor-reducer';

function hold(id: number, cx: number, overrides: Partial<SprayEditorHold> = {}): SprayEditorHold {
  return {
    id,
    cx,
    cy: 10,
    r: 5,
    outline: null,
    source: 'AUTO',
    confidence: 0.9,
    review: 'pending',
    dirty: false,
    ...overrides,
  };
}

describe('revertedHold', () => {
  const first = hold(1, 100);
  const second = hold(2, 200);

  it('names the hold an undo brought back, where it came back to', () => {
    const toggled = { ...second, review: 'rejected' as const };
    expect(revertedHold({ 1: first, 2: toggled }, { 1: first, 2: second })).toEqual({
      cx: 200,
      cy: 10,
      r: 5,
      outline: null,
    });
  });

  it('names the hold an undo took away (an undone add), where it was', () => {
    const added = hold(-1, 50, { source: 'MANUAL', confidence: null });
    expect(revertedHold({ 1: first, [-1]: added }, { 1: first })?.cx).toBe(50);
  });

  it('is null when nothing changed', () => {
    expect(revertedHold({ 1: first, 2: second }, { 1: first, 2: second })).toBeNull();
  });

  it('picks the lowest id when an undo touched several', () => {
    const merged = hold(-3, 150, { source: 'MANUAL' });
    expect(revertedHold({ [-3]: merged }, { 1: first, 2: second })?.cx).toBe(150);
  });
});
