import { describe, it, expect } from 'vitest';
import {
  RANGE_EXTEND_WINDOW_MS,
  isAnyGrade,
  isSingleGrade,
  isRangeGrade,
  clearGradeBound,
  isGradeInRange,
  isGradeEndpoint,
  computeGradeTap,
  type GradeBound,
} from '../grade-range';

// Ascending difficulty_ids, mirroring how the picker feeds them. Gaps between
// ids are intentional so index-neighbor logic (rule 4 trim) can't be confused
// with id arithmetic.
const gradeIds = [10, 12, 14, 16, 18, 20];

const any: GradeBound = { minGradeId: undefined, maxGradeId: undefined };

describe('RANGE_EXTEND_WINDOW_MS', () => {
  it('matches the documented 3000ms window', () => {
    expect(RANGE_EXTEND_WINDOW_MS).toBe(3000);
  });
});

describe('grade-bound predicates', () => {
  it('isAnyGrade is true only when both bounds are undefined', () => {
    expect(isAnyGrade({ minGradeId: undefined, maxGradeId: undefined })).toBe(true);
    expect(isAnyGrade({ minGradeId: 12, maxGradeId: 12 })).toBe(false);
    expect(isAnyGrade({ minGradeId: 12, maxGradeId: undefined })).toBe(false);
    expect(isAnyGrade({ minGradeId: undefined, maxGradeId: 12 })).toBe(false);
  });

  it('isSingleGrade is true only when both bounds are set and equal', () => {
    expect(isSingleGrade({ minGradeId: 14, maxGradeId: 14 })).toBe(true);
    expect(isSingleGrade({ minGradeId: 14, maxGradeId: 16 })).toBe(false);
    expect(isSingleGrade({ minGradeId: undefined, maxGradeId: undefined })).toBe(false);
    expect(isSingleGrade({ minGradeId: 14, maxGradeId: undefined })).toBe(false);
  });

  it('isRangeGrade is true only when both bounds are set and unequal', () => {
    expect(isRangeGrade({ minGradeId: 12, maxGradeId: 18 })).toBe(true);
    expect(isRangeGrade({ minGradeId: 12, maxGradeId: 12 })).toBe(false);
    expect(isRangeGrade({ minGradeId: undefined, maxGradeId: undefined })).toBe(false);
    expect(isRangeGrade({ minGradeId: undefined, maxGradeId: 12 })).toBe(false);
  });

  it('clearGradeBound returns both-undefined', () => {
    expect(clearGradeBound()).toEqual({ minGradeId: undefined, maxGradeId: undefined });
    expect(isAnyGrade(clearGradeBound())).toBe(true);
  });

  it('isGradeInRange is inclusive and false unless both bounds are set', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(isGradeInRange(range, 12)).toBe(true); // lower endpoint
    expect(isGradeInRange(range, 18)).toBe(true); // upper endpoint
    expect(isGradeInRange(range, 14)).toBe(true); // interior
    expect(isGradeInRange(range, 10)).toBe(false); // below
    expect(isGradeInRange(range, 20)).toBe(false); // above
    expect(isGradeInRange({ minGradeId: undefined, maxGradeId: 18 }, 14)).toBe(false);
    expect(isGradeInRange({ minGradeId: 12, maxGradeId: undefined }, 14)).toBe(false);
    expect(isGradeInRange(any, 14)).toBe(false);
  });

  it('isGradeEndpoint matches either endpoint only', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(isGradeEndpoint(range, 12)).toBe(true);
    expect(isGradeEndpoint(range, 18)).toBe(true);
    expect(isGradeEndpoint(range, 14)).toBe(false);
    expect(isGradeEndpoint(range, 20)).toBe(false);
  });
});

describe('computeGradeTap — rule 1: Any -> single', () => {
  it('collapses Any to a single grade regardless of window flag', () => {
    expect(computeGradeTap(any, gradeIds, 14, false)).toEqual({
      next: { minGradeId: 14, maxGradeId: 14 },
    });
    expect(computeGradeTap(any, gradeIds, 14, true)).toEqual({
      next: { minGradeId: 14, maxGradeId: 14 },
    });
  });

  it('emits no meta on Any -> single', () => {
    expect(computeGradeTap(any, gradeIds, 10, false).meta).toBeUndefined();
  });
});

describe('computeGradeTap — rule 2: single -> clear', () => {
  it('tapping the same single grade clears to Any', () => {
    const single: GradeBound = { minGradeId: 14, maxGradeId: 14 };
    expect(computeGradeTap(single, gradeIds, 14, false)).toEqual({
      next: { minGradeId: undefined, maxGradeId: undefined },
    });
    // Window flag must not change clear behaviour.
    expect(computeGradeTap(single, gradeIds, 14, true)).toEqual({
      next: { minGradeId: undefined, maxGradeId: undefined },
    });
  });

  it('emits no meta on clear', () => {
    const single: GradeBound = { minGradeId: 14, maxGradeId: 14 };
    expect(computeGradeTap(single, gradeIds, 14, false).meta).toBeUndefined();
  });
});

describe('computeGradeTap — rule 3: single + different chip', () => {
  it('within window: extends to range [min,max] (tapping higher)', () => {
    const single: GradeBound = { minGradeId: 12, maxGradeId: 12 };
    expect(computeGradeTap(single, gradeIds, 18, true)).toEqual({
      next: { minGradeId: 12, maxGradeId: 18 },
      meta: { extendedRangeWithinWindow: true },
    });
  });

  it('within window: extends to range, normalising order (tapping lower)', () => {
    const single: GradeBound = { minGradeId: 18, maxGradeId: 18 };
    expect(computeGradeTap(single, gradeIds, 12, true)).toEqual({
      next: { minGradeId: 12, maxGradeId: 18 },
      meta: { extendedRangeWithinWindow: true },
    });
  });

  it('outside window: switches single grade with meta false', () => {
    const single: GradeBound = { minGradeId: 12, maxGradeId: 12 };
    expect(computeGradeTap(single, gradeIds, 18, false)).toEqual({
      next: { minGradeId: 18, maxGradeId: 18 },
      meta: { extendedRangeWithinWindow: false },
    });
  });
});

describe('computeGradeTap — rule 4: range endpoint trim', () => {
  it('tapping the lower endpoint trims it inward by one grade index', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    // index of 12 is 1; next index is 2 -> id 14, still <= 18.
    expect(computeGradeTap(range, gradeIds, 12, false)).toEqual({
      next: { minGradeId: 14, maxGradeId: 18 },
    });
  });

  it('tapping the upper endpoint trims it inward by one grade index', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    // index of 18 is 4; prev index is 3 -> id 16, still >= 12.
    expect(computeGradeTap(range, gradeIds, 18, false)).toEqual({
      next: { minGradeId: 12, maxGradeId: 16 },
    });
  });

  it('lower-endpoint trim that would invert collapses to the surviving (max) endpoint', () => {
    // Adjacent two-grade range: trimming the lower endpoint would push min past
    // max, so settle on max as a single grade.
    const range: GradeBound = { minGradeId: 12, maxGradeId: 14 };
    expect(computeGradeTap(range, gradeIds, 12, false)).toEqual({
      next: { minGradeId: 14, maxGradeId: 14 },
    });
  });

  it('upper-endpoint trim that would invert collapses to the surviving (min) endpoint', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 14 };
    expect(computeGradeTap(range, gradeIds, 14, false)).toEqual({
      next: { minGradeId: 12, maxGradeId: 12 },
    });
  });

  it('lower-endpoint trim at the top of the grades array collapses to max', () => {
    // min is the second-to-last grade, max is the last grade. Trimming min
    // inward lands on max -> single.
    const range: GradeBound = { minGradeId: 18, maxGradeId: 20 };
    expect(computeGradeTap(range, gradeIds, 18, false)).toEqual({
      next: { minGradeId: 20, maxGradeId: 20 },
    });
  });

  it('endpoint trim ignores the window flag', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 12, true)).toEqual({
      next: { minGradeId: 14, maxGradeId: 18 },
    });
  });

  it('emits no meta on endpoint trim', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 12, false).meta).toBeUndefined();
  });
});

describe('computeGradeTap — rule 5: range interior collapse', () => {
  it('tapping an interior chip collapses to that single grade', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 14, false)).toEqual({
      next: { minGradeId: 14, maxGradeId: 14 },
    });
    expect(computeGradeTap(range, gradeIds, 16, false).meta).toBeUndefined();
  });
});

describe('computeGradeTap — rule 6: range outside collapse', () => {
  it('tapping a chip below the range collapses to that single grade', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 10, false)).toEqual({
      next: { minGradeId: 10, maxGradeId: 10 },
    });
  });

  it('tapping a chip above the range collapses to that single grade', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 20, false)).toEqual({
      next: { minGradeId: 20, maxGradeId: 20 },
    });
  });

  it('outside-collapse ignores the window flag and emits no meta', () => {
    const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };
    expect(computeGradeTap(range, gradeIds, 20, true)).toEqual({
      next: { minGradeId: 20, maxGradeId: 20 },
    });
  });
});
