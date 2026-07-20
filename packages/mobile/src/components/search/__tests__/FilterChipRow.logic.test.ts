import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { PROGRESS_FILTER_VALUES, progressToFlags, SORT_OPTIONS, GRADE_ACCURACY_VALUES } from '@boardsesh/climb-filters';
import {
  popularityChipLabel,
  ratingChipLabel,
  progressFilterLabel,
  isProgressFilter,
  isSortOption,
  accuracyChipLabel,
  isAccuracyTag,
  climbTypeChipLabel,
  isClimbType,
  collectionChipLabel,
} from '../FilterChipRow.logic';
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

describe('progressFilterLabel', () => {
  it('maps every progress value to its literal i18n key', () => {
    expect(progressFilterLabel('all', mockT)).toBe('mobile.filter.progress.all');
    expect(progressFilterLabel('untried', mockT)).toBe('mobile.filter.progress.untried');
    expect(progressFilterLabel('projects', mockT)).toBe('mobile.filter.progress.projects');
    expect(progressFilterLabel('sent', mockT)).toBe('mobile.filter.progress.sent');
    expect(progressFilterLabel('unsent', mockT)).toBe('mobile.filter.progress.unsent');
  });

  it('produces a non-empty label for every shared PROGRESS_FILTER_VALUE', () => {
    for (const value of PROGRESS_FILTER_VALUES) {
      expect(progressFilterLabel(value, mockT).length).toBeGreaterThan(0);
    }
  });
});

describe('isProgressFilter', () => {
  it('accepts every real progress value', () => {
    for (const value of PROGRESS_FILTER_VALUES) {
      expect(isProgressFilter(value)).toBe(true);
    }
  });

  it('rejects a stray tag string', () => {
    expect(isProgressFilter('nonsense')).toBe(false);
    expect(isProgressFilter('')).toBe(false);
  });
});

// Guards the chip↔flag round trip the menu relies on: picking "Projects" must set
// exactly showOnlyAttempted + hideCompleted (the flags create-climb-filters reads).
describe('progressToFlags (chip commit)', () => {
  it('maps "projects" to attempted-but-not-sent flags', () => {
    expect(progressToFlags('projects')).toEqual({
      hideAttempted: undefined,
      hideCompleted: true,
      showOnlyAttempted: true,
      showOnlyCompleted: undefined,
    });
  });

  it('clears every flag for "all"', () => {
    expect(progressToFlags('all')).toEqual({
      hideAttempted: undefined,
      hideCompleted: undefined,
      showOnlyAttempted: undefined,
      showOnlyCompleted: undefined,
    });
  });
});

// --- Tier-2 chip labels + tag guards. ---

describe('isSortOption', () => {
  it('accepts real sort keys and rejects a stray tag', () => {
    for (const option of SORT_OPTIONS) expect(isSortOption(option)).toBe(true);
    expect(isSortOption('sideways')).toBe(false);
    expect(isSortOption('')).toBe(false);
  });
});

describe('accuracyChipLabel / isAccuracyTag', () => {
  it('maps both the raw "0" value and the "off" tag to the Off label', () => {
    expect(accuracyChipLabel('0', mockT)).toBe('mobile.filter.accuracy.off');
    expect(accuracyChipLabel('off', mockT)).toBe('mobile.filter.accuracy.off');
  });

  it('labels the loose/moderate/tight buckets', () => {
    expect(accuracyChipLabel('0.2', mockT)).toBe('mobile.filter.accuracy.loose');
    expect(accuracyChipLabel('0.1', mockT)).toBe('mobile.filter.accuracy.moderate');
    expect(accuracyChipLabel('0.05', mockT)).toBe('mobile.filter.accuracy.tight');
  });

  it('accepts the chip tags ("off" + every non-zero accuracy value) and rejects others', () => {
    expect(isAccuracyTag('off')).toBe(true);
    for (const value of GRADE_ACCURACY_VALUES) {
      // '0' is never a chip tag — it maps to 'off'.
      if (value !== '0') expect(isAccuracyTag(value)).toBe(true);
    }
    expect(isAccuracyTag('0')).toBe(false);
    expect(isAccuracyTag('0.99')).toBe(false);
  });
});

describe('collectionChipLabel', () => {
  it('labels each collection value', () => {
    expect(collectionChipLabel('benchmarks', mockT)).toBe('mobile.filter.benchmark');
    expect(collectionChipLabel('drafts', mockT)).toBe('mobile.filter.drafts');
    expect(collectionChipLabel('any', mockT)).toBe('mobile.filter.collection.any');
  });
});

describe('climbTypeChipLabel / isClimbType', () => {
  it('labels each climb-type value', () => {
    expect(climbTypeChipLabel('boulders', mockT)).toBe('mobile.filter.boulders');
    expect(climbTypeChipLabel('routes', mockT)).toBe('mobile.filter.routes');
    expect(climbTypeChipLabel('both', mockT)).toBe('mobile.filter.both');
  });

  it('accepts the three values and rejects others', () => {
    for (const value of ['boulders', 'routes', 'both'] as const) expect(isClimbType(value)).toBe(true);
    expect(isClimbType('slab')).toBe(false);
    expect(isClimbType('')).toBe(false);
  });
});
