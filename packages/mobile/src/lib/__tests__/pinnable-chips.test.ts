import { describe, it, expect } from 'vitest';
import {
  PINNABLE_CHIP_CATALOG,
  DEFAULT_PINNED_CHIPS,
  isValidChipKind,
  normalizePinnedChips,
  chipKindToTokenKeys,
  type PinnableChipKind,
} from '../pinnable-chips';

describe('pinnable-chips catalog', () => {
  it('lists every pinnable control in fixed render order', () => {
    expect([...PINNABLE_CHIP_CATALOG]).toEqual([
      'grade',
      'accuracy',
      'progress',
      'collection',
      'climbType',
      'shape',
      'beta',
      'popularity',
      'rating',
      'sort',
    ]);
  });

  it('defaults to only the Tier-1 chips (reproduces today’s chip row; Tier-2 is opt-in)', () => {
    expect([...DEFAULT_PINNED_CHIPS]).toEqual(['grade', 'progress', 'collection', 'shape', 'popularity', 'rating']);
    // Tier-2 controls are in the catalog but not pinned by default.
    for (const optIn of ['accuracy', 'climbType', 'beta', 'sort'] as const) {
      expect(PINNABLE_CHIP_CATALOG).toContain(optIn);
      expect(DEFAULT_PINNED_CHIPS).not.toContain(optIn);
    }
  });

  it('isValidChipKind accepts known kinds and rejects everything else', () => {
    for (const kind of PINNABLE_CHIP_CATALOG) expect(isValidChipKind(kind)).toBe(true);
    expect(isValidChipKind('setters')).toBe(false);
    expect(isValidChipKind('')).toBe(false);
    expect(isValidChipKind(null)).toBe(false);
    expect(isValidChipKind(42)).toBe(false);
  });
});

describe('normalizePinnedChips', () => {
  it('re-sorts into canonical order regardless of input order', () => {
    expect(normalizePinnedChips(['rating', 'grade', 'popularity'])).toEqual(['grade', 'popularity', 'rating']);
  });

  it('drops unknown kinds (incl. the retired "benchmarks") and de-dupes', () => {
    expect(normalizePinnedChips(['grade', 'benchmarks', 'grade', 'shape'])).toEqual(['grade', 'shape']);
  });

  it('returns an empty array when nothing valid is left', () => {
    expect(normalizePinnedChips(['nope', 123, null])).toEqual([]);
  });
});

describe('chipKindToTokenKeys', () => {
  it('maps each kind to the filter-token keys it backs', () => {
    const map: Record<PinnableChipKind, readonly string[]> = {
      grade: ['grade'],
      accuracy: ['gradeAccuracy'],
      progress: ['progress'],
      collection: ['benchmark'],
      climbType: ['climbType'],
      shape: ['tall', 'wide'],
      beta: ['beta'],
      popularity: ['minAscents'],
      rating: ['minRating'],
      sort: ['sort'],
    };
    for (const kind of PINNABLE_CHIP_CATALOG) {
      expect([...chipKindToTokenKeys(kind)]).toEqual(map[kind]);
    }
  });
});
