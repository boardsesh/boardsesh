import { describe, expect, it } from 'vitest';
import { bandStarts, gradeStops, moveThumb, rangeFromStops, stopRange, thumbFor } from './grade-range';

// 6a … 7a on the Font scale: difficulty ids 16-22.
const FONT = gradeStops(
  ['6A', '6A+', '6B', '6B+', '6C', '6C+', '7A'].map((label, index) => ({ difficultyId: 16 + index, label })),
);
const V_SCALE = gradeStops([
  { difficultyId: 16, label: 'V3' },
  { difficultyId: 17, label: 'V3' },
  { difficultyId: 18, label: 'V4' },
  { difficultyId: 19, label: 'V4' },
  { difficultyId: 20, label: 'V5' },
]);

describe('gradeStops', () => {
  it('gives V grades that share a label one stop', () => {
    expect(V_SCALE).toEqual([
      { label: 'V3', difficultyIds: [16, 17] },
      { label: 'V4', difficultyIds: [18, 19] },
      { label: 'V5', difficultyIds: [20] },
    ]);
  });
});

describe('stopRange', () => {
  it('spans the whole scale without a filter', () => {
    expect(stopRange(FONT, { minGrade: null, maxGrade: null })).toEqual({ min: 0, max: 6 });
  });

  it('puts an open end at that end of the scale', () => {
    expect(stopRange(FONT, { minGrade: 20, maxGrade: null })).toEqual({ min: 4, max: 6 });
    expect(stopRange(FONT, { minGrade: null, maxGrade: 19 })).toEqual({ min: 0, max: 3 });
  });

  it('clamps grades the board does not have', () => {
    expect(stopRange(FONT, { minGrade: 10, maxGrade: 40 })).toEqual({ min: 0, max: 6 });
  });
});

describe('rangeFromStops', () => {
  it('leaves an end open when its thumb sits at the end of the scale', () => {
    expect(rangeFromStops(FONT, { min: 0, max: 6 })).toEqual({ minGrade: null, maxGrade: null });
    expect(rangeFromStops(FONT, { min: 4, max: 6 })).toEqual({ minGrade: 20, maxGrade: null });
  });

  it('covers every difficulty id behind a V stop', () => {
    expect(rangeFromStops(V_SCALE, { min: 1, max: 1 })).toEqual({ minGrade: 18, maxGrade: 19 });
  });

  it('round-trips through stopRange', () => {
    const range = { minGrade: 18, maxGrade: 21 };
    expect(rangeFromStops(FONT, stopRange(FONT, range))).toEqual(range);
  });
});

describe('thumbFor', () => {
  it('takes the thumb on the touched side', () => {
    expect(thumbFor({ min: 2, max: 4 }, 0, 0)).toBe('min');
    expect(thumbFor({ min: 2, max: 4 }, 6, 0)).toBe('max');
  });

  it('takes the nearer thumb between them', () => {
    expect(thumbFor({ min: 0, max: 6 }, 1, 0)).toBe('min');
    expect(thumbFor({ min: 0, max: 6 }, 5, 0)).toBe('max');
  });

  it('lets level thumbs part in the direction of the drag', () => {
    expect(thumbFor({ min: 3, max: 3 }, 3, -1)).toBe('min');
    expect(thumbFor({ min: 3, max: 3 }, 3, 1)).toBe('max');
  });
});

describe('moveThumb', () => {
  it('stops a thumb at the other one', () => {
    expect(moveThumb({ min: 1, max: 4 }, 'min', 6)).toEqual({ min: 4, max: 4 });
    expect(moveThumb({ min: 1, max: 4 }, 'max', 0)).toEqual({ min: 1, max: 1 });
    expect(moveThumb({ min: 1, max: 4 }, 'max', 5)).toEqual({ min: 1, max: 5 });
  });
});

describe('bandStarts', () => {
  it('marks where each grade band begins', () => {
    // 6A and 6A+ share the first band, then 6B, 6C and 7A each start one.
    expect(bandStarts(FONT)).toEqual([0, 2, 4, 6]);
    expect(bandStarts(V_SCALE)).toEqual([0, 1, 2]);
  });
});
