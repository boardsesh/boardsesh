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
  it('defaults to the whole catalog (reproduces today’s chip row)', () => {
    expect(DEFAULT_PINNED_CHIPS).toEqual(PINNABLE_CHIP_CATALOG);
    expect([...PINNABLE_CHIP_CATALOG]).toEqual(['grade', 'progress', 'collection', 'shape', 'popularity', 'rating']);
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
      progress: ['progress'],
      collection: ['benchmark'],
      shape: ['tall', 'wide'],
      popularity: ['minAscents'],
      rating: ['minRating'],
    };
    for (const kind of PINNABLE_CHIP_CATALOG) {
      expect([...chipKindToTokenKeys(kind)]).toEqual(map[kind]);
    }
  });
});
