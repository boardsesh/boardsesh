import { describe, it, expect } from 'vitest';

import { correctGripsQualityAverage } from './quality-scale';

describe('correctGripsQualityAverage', () => {
  it('stores the Grips value verbatim — it is already on the 1-5 scale', () => {
    // A Grips 3.0 is a real 3-of-5 (Kilter compresses its legacy ratings toward
    // 3 via its own 1-3→1-5 migration); it MUST stay 3.0, not be rescaled up.
    expect(correctGripsQualityAverage(3.0)).toBe(3.0);
    expect(correctGripsQualityAverage(2.0)).toBe(2.0);
    expect(correctGripsQualityAverage(1.0)).toBe(1.0);
    expect(correctGripsQualityAverage(2.5)).toBe(2.5);
    expect(correctGripsQualityAverage(4.33)).toBe(4.33);
    expect(correctGripsQualityAverage(5.0)).toBe(5.0);
  });

  it('does NOT rescale (regression guard: the old 2q−1 pushed 3.0 → 5.0)', () => {
    expect(correctGripsQualityAverage(3.0)).not.toBe(5.0);
    expect(correctGripsQualityAverage(4.0)).not.toBe(5.0);
    expect(correctGripsQualityAverage(4.0)).toBe(4.0);
  });

  it('treats non-ratings as null (< 1 unrated/fractional, > 5 garbage, non-finite)', () => {
    expect(correctGripsQualityAverage(null)).toBeNull();
    expect(correctGripsQualityAverage(undefined)).toBeNull();
    expect(correctGripsQualityAverage(0)).toBeNull();
    expect(correctGripsQualityAverage(-1)).toBeNull();
    expect(correctGripsQualityAverage(5.0001)).toBeNull();
    expect(correctGripsQualityAverage(10)).toBeNull();
    expect(correctGripsQualityAverage(Number.NaN)).toBeNull();
    // A 1-5 star scale has no valid value below 1 — a sub-one fraction (e.g. a
    // pre-cutover blend gone wrong) is as much garbage as 0 or a negative.
    expect(correctGripsQualityAverage(0.2)).toBeNull();
    expect(correctGripsQualityAverage(0.99)).toBeNull();
    // 1.0 is the lowest valid rating and must survive unchanged.
    expect(correctGripsQualityAverage(1.0)).toBe(1.0);
  });
});
