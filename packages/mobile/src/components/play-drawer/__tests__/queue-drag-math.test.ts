import { describe, it, expect } from 'vitest';
import {
  queueIndexForRow,
  clampRowIndex,
  dropRowIndex,
  rowReorderShift,
  resolveReorderCommit,
} from '../queue-drag-math';

// The future-item window is a contiguous block of flat-list rows that maps 1:1
// onto a contiguous slice of the queue array. Example used throughout: history
// (rows 0–1) + current (row 2) + future rows 3,4,5,6 → queue indices 3,4,5,6,
// so firstRowIndex = 3 and firstQueueIndex = 3 (they happen to match here), and
// a case where they DON'T match to prove the offset is honoured.

describe('queueIndexForRow', () => {
  it('maps a future row index to its queue index by constant offset', () => {
    expect(queueIndexForRow(3, 3, 3)).toBe(3);
    expect(queueIndexForRow(6, 3, 3)).toBe(6);
  });

  it('honours an offset between row index and queue index', () => {
    // e.g. a collapsed history "show all" row shifts flat indices by 1 vs queue
    // indices: future rows 4,5,6 → queue 2,3,4 (firstRowIndex 4, firstQueueIndex 2)
    expect(queueIndexForRow(4, 4, 2)).toBe(2);
    expect(queueIndexForRow(6, 4, 2)).toBe(4);
  });
});

describe('clampRowIndex', () => {
  it('clamps below the window to the first row', () => {
    expect(clampRowIndex(1, 3, 6)).toBe(3);
  });
  it('clamps above the window to the last row', () => {
    expect(clampRowIndex(9, 3, 6)).toBe(6);
  });
  it('passes values already inside the window through', () => {
    expect(clampRowIndex(4, 3, 6)).toBe(4);
  });
});

describe('dropRowIndex', () => {
  const FIRST = 3;
  const LAST = 6;
  const H = 100;

  it('returns the start row for no movement', () => {
    expect(dropRowIndex(4, 0, H, FIRST, LAST)).toBe(4);
  });
  it('rounds a partial drag to the nearest row', () => {
    expect(dropRowIndex(4, 60, H, FIRST, LAST)).toBe(5); // +0.6 row → +1
    expect(dropRowIndex(4, 40, H, FIRST, LAST)).toBe(4); // +0.4 row → 0
  });
  it('moves multiple rows down', () => {
    expect(dropRowIndex(3, 250, H, FIRST, LAST)).toBe(6); // +2.5 → +3 → clamp 6
  });
  it('moves up and clamps at the first future row (cannot enter history/current)', () => {
    expect(dropRowIndex(5, -500, H, FIRST, LAST)).toBe(FIRST);
  });
  it('clamps at the last future row (cannot enter suggestions)', () => {
    expect(dropRowIndex(4, 500, H, FIRST, LAST)).toBe(LAST);
  });
});

describe('rowReorderShift', () => {
  const H = 100;

  it('does not shift the dragged row itself', () => {
    expect(rowReorderShift(4, 4, 6, H)).toBe(0);
  });

  it('shifts rows the dragged row passes while moving DOWN up by one row', () => {
    // dragging row 3 down to 5: rows 4 and 5 move up by H, row 6 stays
    expect(rowReorderShift(4, 3, 5, H)).toBe(-H);
    expect(rowReorderShift(5, 3, 5, H)).toBe(-H);
    expect(rowReorderShift(6, 3, 5, H)).toBe(0);
  });

  it('shifts rows the dragged row passes while moving UP down by one row', () => {
    // dragging row 6 up to 4: rows 4 and 5 move down by H, row 3 stays
    expect(rowReorderShift(5, 6, 4, H)).toBe(H);
    expect(rowReorderShift(4, 6, 4, H)).toBe(H);
    expect(rowReorderShift(3, 6, 4, H)).toBe(0);
  });

  it('does not shift rows outside the dragged span', () => {
    expect(rowReorderShift(3, 4, 6, H)).toBe(0); // below the span
    expect(rowReorderShift(7, 4, 6, H)).toBe(0); // above the span
  });

  it('no shift when target equals active (no movement)', () => {
    expect(rowReorderShift(4, 5, 5, H)).toBe(0);
    expect(rowReorderShift(6, 5, 5, H)).toBe(0);
  });
});

describe('resolveReorderCommit', () => {
  // Future window: flat rows 3..6 ↔ queue indices 3..6 (offset 0 here).
  const WINDOW = { firstRowIndex: 3, firstQueueIndex: 3 };

  it('maps the drop row to a queue move', () => {
    expect(resolveReorderCommit('a', 3, 5, WINDOW)).toEqual({ uuid: 'a', oldIndex: 3, newIndex: 5 });
  });

  it('honours a row/queue index offset', () => {
    // history "show all" row shifts flat indices +1 vs queue indices
    expect(resolveReorderCommit('a', 2, 6, { firstRowIndex: 4, firstQueueIndex: 2 })).toEqual({
      uuid: 'a',
      oldIndex: 2,
      newIndex: 4,
    });
  });

  it('returns null when the item did not move', () => {
    expect(resolveReorderCommit('a', 4, 4, WINDOW)).toBeNull();
  });

  it('returns null when there is no draggable window', () => {
    expect(resolveReorderCommit('a', 0, 0, { firstRowIndex: -1, firstQueueIndex: -1 })).toBeNull();
  });
});
