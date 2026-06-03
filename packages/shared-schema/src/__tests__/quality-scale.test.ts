import { describe, expect, it } from 'vitest';

import { convertQuality, normalizeQualityTo5 } from '../utils';

void describe('normalizeQualityTo5', () => {
  it('scales a 1-3 average onto 1-5 (×5/3, continuous)', () => {
    expect(normalizeQualityTo5(3)).toBeCloseTo(5);
    expect(normalizeQualityTo5(1)).toBeCloseTo(5 / 3);
    expect(normalizeQualityTo5(2.79)).toBeCloseTo(4.65, 2); // a real averaged value
  });

  it('treats unrated (null/≤0) as null, never 0', () => {
    expect(normalizeQualityTo5(null)).toBeNull();
    expect(normalizeQualityTo5(undefined)).toBeNull();
    expect(normalizeQualityTo5(0)).toBeNull();
  });

  it('does not round — averages stay continuous (unlike convertQuality)', () => {
    expect(normalizeQualityTo5(1.5)).toBeCloseTo(2.5);
    expect(convertQuality(1.5)).toBe(2); // convertQuality rounds a single rating
    expect(normalizeQualityTo5(1.5)).not.toBe(convertQuality(1.5));
  });
});
