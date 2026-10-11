import { describe, it, expect } from 'vitest';
import {
  isAnyGrade,
  isSingleGrade,
  isRangeGrade,
  clearGradeBound,
  isGradeInRange,
  isGradeEndpoint,
  computeGradeTap,
  collapseToLowerEnd,
  type GradeBound,
} from '../grade-range';

// Difficulty ids with gaps between them, so a rule that did arithmetic on an id
// instead of using the ids it was given would land on a grade that is not in
// the scale.
const any: GradeBound = { minGradeId: undefined, maxGradeId: undefined };
const single: GradeBound = { minGradeId: 14, maxGradeId: 14 };
const range: GradeBound = { minGradeId: 12, maxGradeId: 18 };

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
    expect(isGradeEndpoint(range, 12)).toBe(true);
    expect(isGradeEndpoint(range, 18)).toBe(true);
    expect(isGradeEndpoint(range, 14)).toBe(false);
    expect(isGradeEndpoint(range, 20)).toBe(false);
  });
});

describe('computeGradeTap with range mode off', () => {
  it('picks the tapped grade from Any', () => {
    expect(computeGradeTap(any, 14, false)).toEqual({ minGradeId: 14, maxGradeId: 14 });
  });

  it('clears to Any when the selected single grade is tapped again', () => {
    expect(computeGradeTap(single, 14, false)).toEqual({ minGradeId: undefined, maxGradeId: undefined });
  });

  it('switches to the tapped grade from another single grade, never a range', () => {
    expect(computeGradeTap(single, 18, false)).toEqual({ minGradeId: 18, maxGradeId: 18 });
    expect(computeGradeTap(single, 10, false)).toEqual({ minGradeId: 10, maxGradeId: 10 });
  });

  it('replaces a range with the tapped grade, wherever the tap lands', () => {
    expect(computeGradeTap(range, 12, false)).toEqual({ minGradeId: 12, maxGradeId: 12 }); // lower end
    expect(computeGradeTap(range, 18, false)).toEqual({ minGradeId: 18, maxGradeId: 18 }); // upper end
    expect(computeGradeTap(range, 14, false)).toEqual({ minGradeId: 14, maxGradeId: 14 }); // inside
    expect(computeGradeTap(range, 20, false)).toEqual({ minGradeId: 20, maxGradeId: 20 }); // outside
  });
});

describe('computeGradeTap with range mode on', () => {
  it('makes the tapped grade the first end from Any', () => {
    expect(computeGradeTap(any, 14, true)).toEqual({ minGradeId: 14, maxGradeId: 14 });
  });

  it('builds a range from a single grade and a higher tap', () => {
    expect(computeGradeTap(single, 18, true)).toEqual({ minGradeId: 14, maxGradeId: 18 });
  });

  it('builds a range in ascending order from a single grade and a lower tap', () => {
    expect(computeGradeTap(single, 10, true)).toEqual({ minGradeId: 10, maxGradeId: 14 });
  });

  it('clears to Any when the selected single grade is tapped again', () => {
    expect(computeGradeTap(single, 14, true)).toEqual({ minGradeId: undefined, maxGradeId: undefined });
  });

  it('starts a new range from the tapped grade when a range is already set', () => {
    expect(computeGradeTap(range, 12, true)).toEqual({ minGradeId: 12, maxGradeId: 12 }); // lower end
    expect(computeGradeTap(range, 18, true)).toEqual({ minGradeId: 18, maxGradeId: 18 }); // upper end
    expect(computeGradeTap(range, 14, true)).toEqual({ minGradeId: 14, maxGradeId: 14 }); // inside
    expect(computeGradeTap(range, 20, true)).toEqual({ minGradeId: 20, maxGradeId: 20 }); // outside
  });
});

describe('computeGradeTap from a half-set bound', () => {
  // Only one bound set is neither Any, a single grade nor a range. A tap starts
  // over on the tapped grade in both modes, including a tap on the set bound.
  const lowerOnly: GradeBound = { minGradeId: 12, maxGradeId: undefined };
  const upperOnly: GradeBound = { minGradeId: undefined, maxGradeId: 18 };

  it.each([false, true])('picks the tapped grade (range mode %s)', (rangeMode) => {
    expect(computeGradeTap(lowerOnly, 16, rangeMode)).toEqual({ minGradeId: 16, maxGradeId: 16 });
    expect(computeGradeTap(lowerOnly, 12, rangeMode)).toEqual({ minGradeId: 12, maxGradeId: 12 });
    expect(computeGradeTap(upperOnly, 18, rangeMode)).toEqual({ minGradeId: 18, maxGradeId: 18 });
  });
});

describe('collapseToLowerEnd', () => {
  it('turns a range into the single grade at its lower end', () => {
    expect(collapseToLowerEnd(range)).toEqual({ minGradeId: 12, maxGradeId: 12 });
  });

  it('returns a single grade as is', () => {
    expect(collapseToLowerEnd(single)).toBe(single);
  });

  it('returns Any as is', () => {
    expect(collapseToLowerEnd(any)).toBe(any);
  });

  it('returns a half-set bound as is', () => {
    const lowerOnly: GradeBound = { minGradeId: 12, maxGradeId: undefined };
    expect(collapseToLowerEnd(lowerOnly)).toBe(lowerOnly);
  });
});
