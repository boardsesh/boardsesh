import { describe, it, expect } from 'vitest';
import type { HoldFilterEntry, HoldsFilter } from '@boardsesh/shared-schema';
import {
  ANY_HOLD_COLOR,
  buildHoldFilterOptions,
  countFilteredHolds,
  parseHoldsFilter,
  sanitizeHoldsFilter,
  toggleHoldFilterType,
} from '../hold-filter-options';

describe('buildHoldFilterOptions', () => {
  it('lists the named Kilter roles followed by the ANY wildcard', () => {
    const options = buildHoldFilterOptions('kilter');
    const types = options.map((option) => option.type);
    expect(types).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT', 'ANY']);
    // ANY has no LED colour, so it falls back to the plain-white swatch.
    expect(options.at(-1)).toEqual({ type: 'ANY', color: ANY_HOLD_COLOR });
  });

  it('drops FOOT for MoonBoard but keeps ANY', () => {
    const types = buildHoldFilterOptions('moonboard').map((option) => option.type);
    expect(types).toEqual(['STARTING', 'HAND', 'FINISH', 'ANY']);
  });

  it('pulls swatch colours from the board hold-state map', () => {
    const starting = buildHoldFilterOptions('kilter').find((option) => option.type === 'STARTING');
    expect(starting?.color).toMatch(/^#/);
    expect(starting?.color).not.toBe(ANY_HOLD_COLOR);
  });

  it('never surfaces non-setter hold states (OFF / NOT / AUX) as options', () => {
    // MoonBoard's HOLD_STATE_MAP carries an AUX live-preview role; the membership
    // guard must keep it (and any OFF/NOT) out of the filter options.
    const types = buildHoldFilterOptions('moonboard').map((option) => option.type);
    expect(types).not.toContain('AUX');
    expect(types).not.toContain('OFF');
    expect(types).not.toContain('NOT');
  });
});

describe('toggleHoldFilterType', () => {
  it('sets an unset type to the apply mode', () => {
    expect(toggleHoldFilterType({}, 'STARTING', 'include')).toEqual({ STARTING: 'include' });
    expect(toggleHoldFilterType({}, 'HAND', 'exclude')).toEqual({ HAND: 'exclude' });
  });

  it('unsets a type already at the apply mode', () => {
    const entry: HoldFilterEntry = { FOOT: 'include' };
    expect(toggleHoldFilterType(entry, 'FOOT', 'include')).toEqual({});
  });

  it('flips a type from the other mode to the apply mode', () => {
    const entry: HoldFilterEntry = { FINISH: 'include' };
    expect(toggleHoldFilterType(entry, 'FINISH', 'exclude')).toEqual({ FINISH: 'exclude' });
  });

  it('does not mutate the input entry', () => {
    const entry: HoldFilterEntry = { ANY: 'include' };
    toggleHoldFilterType(entry, 'STARTING', 'include');
    expect(entry).toEqual({ ANY: 'include' });
  });
});

describe('countFilteredHolds', () => {
  it('counts only holds with at least one active type', () => {
    const filter: HoldsFilter = {
      '10': { STARTING: 'include' },
      '20': { HAND: 'exclude', FOOT: 'include' },
      '30': {},
    };
    expect(countFilteredHolds(filter)).toBe(2);
  });

  it('returns 0 for an empty or undefined filter', () => {
    expect(countFilteredHolds({})).toBe(0);
    expect(countFilteredHolds(undefined)).toBe(0);
  });
});

describe('parseHoldsFilter', () => {
  it('returns an empty filter for missing or empty input', () => {
    expect(parseHoldsFilter(undefined)).toEqual({});
    expect(parseHoldsFilter(null)).toEqual({});
    expect(parseHoldsFilter('')).toEqual({});
  });

  it('returns an empty filter for malformed JSON', () => {
    expect(parseHoldsFilter('{not json')).toEqual({});
  });

  it('returns an empty filter for non-object JSON (array, number, string)', () => {
    expect(parseHoldsFilter('[1,2,3]')).toEqual({});
    expect(parseHoldsFilter('42')).toEqual({});
    expect(parseHoldsFilter('"hand"')).toEqual({});
  });

  it('parses a valid serialized filter', () => {
    const raw = JSON.stringify({ '12': { HAND: 'include', FOOT: 'exclude' } });
    expect(parseHoldsFilter(raw)).toEqual({ '12': { HAND: 'include', FOOT: 'exclude' } });
  });

  it('rejects an invalid leaf mode value and drops the now-empty hold', () => {
    // A crafted param sets a leaf to something outside include/exclude; it must
    // not propagate to analytics or the GraphQL query.
    const raw = JSON.stringify({ '12': { HAND: 'maybe' } });
    expect(parseHoldsFilter(raw)).toEqual({});
  });

  it('keeps valid leaves while stripping invalid ones on the same hold', () => {
    const raw = JSON.stringify({ '12': { HAND: 'include', FOOT: 'sometimes' } });
    expect(parseHoldsFilter(raw)).toEqual({ '12': { HAND: 'include' } });
  });

  it('drops holds whose entry is not a plain object', () => {
    const raw = JSON.stringify({ '12': 'include', '13': ['HAND'], '14': { ANY: 'exclude' } });
    expect(parseHoldsFilter(raw)).toEqual({ '14': { ANY: 'exclude' } });
  });
});

describe('sanitizeHoldsFilter', () => {
  it('strips non-string and out-of-union leaf values', () => {
    const raw: Record<string, unknown> = {
      '1': { HAND: 'include', FOOT: 3, FINISH: 'nope' },
      '2': { ANY: 'exclude' },
    };
    expect(sanitizeHoldsFilter(raw)).toEqual({ '1': { HAND: 'include' }, '2': { ANY: 'exclude' } });
  });
});
