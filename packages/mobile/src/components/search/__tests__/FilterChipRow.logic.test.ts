import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { popularityChipLabel, ratingChipLabel } from '../FilterChipRow.logic';
import { POPULARITY_BUCKETS, RATING_BUCKETS } from '../../../lib/filter-chip-menus';

// Mirrors filter-labels.test.ts: the mock t returns the key (with interpolated
// placeholders for readable assertions) for parametric keys, else the key itself.
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'mobile.search.rating') return `${text(opts?.count)}+ ⭐`;
  return key;
}) as unknown as TFunction<'climbs'>;

describe('popularityChipLabel', () => {
  it('uses mobile.filter.anyAscents for the undefined bucket', () => {
    expect(popularityChipLabel(undefined, mockT)).toBe('mobile.filter.anyAscents');
  });

  it('uses mobile.filter.established2plus for the 2 bucket (not "2+")', () => {
    expect(popularityChipLabel(2, mockT)).toBe('mobile.filter.established2plus');
  });

  it('formats other buckets as "<count>+" via formatMinAscentsFilterCount', () => {
    expect(popularityChipLabel(10, mockT)).toBe('10+');
    expect(popularityChipLabel(100, mockT)).toBe('100+');
    expect(popularityChipLabel(1000, mockT)).toBe('1k+');
  });

  it('produces a non-empty label for every shared POPULARITY_BUCKET', () => {
    for (const bucket of POPULARITY_BUCKETS) {
      expect(popularityChipLabel(bucket, mockT).length).toBeGreaterThan(0);
    }
  });
});

describe('ratingChipLabel', () => {
  it('uses mobile.filter.anyRating for the undefined bucket', () => {
    expect(ratingChipLabel(undefined, mockT)).toBe('mobile.filter.anyRating');
  });

  it('uses the localised star wording with count for a rating bucket', () => {
    expect(ratingChipLabel(3, mockT)).toBe('3+ ⭐');
  });

  it('produces a non-empty label for every shared RATING_BUCKET', () => {
    for (const bucket of RATING_BUCKETS) {
      expect(ratingChipLabel(bucket, mockT).length).toBeGreaterThan(0);
    }
  });
});
