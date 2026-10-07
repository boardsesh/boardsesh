import { describe, expect, it } from 'vitest';
import { readingCursorPosition, readingOrderIndex, sprayHoldReadingOrder, stepReadingCursor } from '../spray-hold-a11y';

function hold(id: number, cx: number, cy: number, r = 10) {
  return { id, cx, cy, r, outline: null };
}

describe('sprayHoldReadingOrder', () => {
  it('is empty for an empty wall', () => {
    expect(sprayHoldReadingOrder([], 10)).toEqual([]);
  });

  it('reads rows top to bottom and left to right within a row', () => {
    const holds = [hold(4, 300, 500), hold(1, 100, 100), hold(3, 100, 505), hold(2, 250, 96)];
    expect(sprayHoldReadingOrder(holds, 10)).toEqual([1, 2, 3, 4]);
  });

  it('buckets rows on the median radius, not on the hold that starts the row', () => {
    // A crimp (r 2) starts the row; the jug to its left sits 6 px lower. With
    // the row anchored on the crimp's own radius the jug would be read as a row
    // of its own and come AFTER the crimp to its right. Against the wall's
    // median (10) both are one row, read left to right.
    const holds = [hold(1, 300, 100, 2), hold(2, 10, 106, 20), hold(3, 50, 200, 10)];
    expect(sprayHoldReadingOrder(holds, 10)).toEqual([2, 1, 3]);
  });

  it('splits holds further apart than the tolerance into separate rows', () => {
    const holds = [hold(1, 500, 100), hold(2, 10, 100 + 10 * 0.8 + 1)];
    expect(sprayHoldReadingOrder(holds, 10)).toEqual([1, 2]);
  });

  it('survives a zero radius by bucketing only exact rows together', () => {
    const holds = [hold(2, 200, 100), hold(1, 100, 100), hold(3, 0, 101)];
    expect(sprayHoldReadingOrder(holds, 0)).toEqual([1, 2, 3]);
  });
});

describe('stepReadingCursor', () => {
  const order = [7, 3, 9];
  const indexById = readingOrderIndex(order);

  it('enters at the first hold going forward and the last going back', () => {
    expect(stepReadingCursor(order, indexById, null, 1)).toBe(7);
    expect(stepReadingCursor(order, indexById, null, -1)).toBe(9);
  });

  it('steps through the order and wraps at both ends', () => {
    expect(stepReadingCursor(order, indexById, 7, 1)).toBe(3);
    expect(stepReadingCursor(order, indexById, 9, 1)).toBe(7);
    expect(stepReadingCursor(order, indexById, 7, -1)).toBe(9);
  });

  it('re-enters when the cursor hold has gone', () => {
    expect(stepReadingCursor(order, indexById, 42, 1)).toBe(7);
  });

  it('is null on an empty wall', () => {
    expect(stepReadingCursor([], new Map(), null, 1)).toBeNull();
  });
});

describe('readingCursorPosition', () => {
  const indexById = readingOrderIndex([7, 3, 9]);

  it('is 1-based with the total', () => {
    expect(readingCursorPosition(indexById, 3)).toEqual({ position: 2, total: 3 });
  });

  it('is null with no cursor or a cursor off the walk', () => {
    expect(readingCursorPosition(indexById, null)).toBeNull();
    expect(readingCursorPosition(indexById, 42)).toBeNull();
  });
});
