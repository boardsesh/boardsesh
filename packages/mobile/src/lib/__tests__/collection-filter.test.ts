import { describe, it, expect } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE } from '@boardsesh/climb-filters';
import {
  collectionPatch,
  getCollectionFilter,
  getClimbTypeFilter,
  isCollectionFilter,
  isPersonalCollection,
  COLLECTION_VALUES,
} from '../collection-filter';

describe('getCollectionFilter', () => {
  it('reads benchmarks / drafts / any from the two flags', () => {
    expect(getCollectionFilter({ status: 'any' }, { onlyBenchmarks: true })).toBe('benchmarks');
    expect(getCollectionFilter({ status: 'drafts' }, {})).toBe('drafts');
    expect(getCollectionFilter({ status: 'any' }, {})).toBe('any');
  });

  it('prefers benchmarks if both flags are somehow set', () => {
    expect(getCollectionFilter({ status: 'drafts' }, { onlyBenchmarks: true })).toBe('benchmarks');
  });

  it('treats projects (Unrepeated) as "any" — it belongs to Popularity, not Collection', () => {
    expect(getCollectionFilter({ status: 'projects' }, {})).toBe('any');
  });

  it('reads liked from onlyFavorited (#6002)', () => {
    expect(getCollectionFilter({ status: 'any', onlyFavorited: true }, {})).toBe('liked');
    expect(getCollectionFilter({ status: 'any', onlyFavorited: false }, {})).toBe('any');
  });
});

describe('collectionPatch', () => {
  const apply = (value: Parameters<typeof collectionPatch>[0], filters = DEFAULT_CLIMB_FILTER_STATE) => {
    const patch = collectionPatch(value, filters);
    return { filters: { ...filters, ...patch.filters }, boardFilters: patch.boardFilters };
  };

  it('Liked sets onlyFavorited and clears Benchmarks and My drafts', () => {
    const fromDrafts = apply('liked', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' });
    expect(fromDrafts.filters.onlyFavorited).toBe(true);
    expect(fromDrafts.filters.status).toBe('any');
    expect(fromDrafts.boardFilters.onlyBenchmarks).toBeUndefined();
    expect(getCollectionFilter(fromDrafts.filters, fromDrafts.boardFilters)).toBe('liked');
  });

  it.each(['any', 'benchmarks', 'drafts'] as const)('%s clears Liked', (value) => {
    const result = apply(value, { ...DEFAULT_CLIMB_FILTER_STATE, onlyFavorited: true });
    expect(result.filters.onlyFavorited).toBeUndefined();
    expect(getCollectionFilter(result.filters, result.boardFilters)).toBe(value);
  });

  it('Benchmarks clears a drafts status but keeps Unrepeated', () => {
    expect(apply('benchmarks', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' }).filters.status).toBe('any');
    expect(apply('benchmarks', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'projects' }).filters.status).toBe('projects');
  });
});

describe('isPersonalCollection', () => {
  it('marks My drafts and Liked as needing an account', () => {
    expect(COLLECTION_VALUES.filter(isPersonalCollection)).toEqual(['drafts', 'liked']);
  });
});

describe('isCollectionFilter', () => {
  it('guards the four values and rejects others', () => {
    for (const value of COLLECTION_VALUES) expect(isCollectionFilter(value)).toBe(true);
    expect(isCollectionFilter('benchmark')).toBe(false);
    expect(isCollectionFilter('')).toBe(false);
  });
});

describe('getClimbTypeFilter', () => {
  it('reads the three picks out of the boulders/routes flags', () => {
    expect(getClimbTypeFilter({ boulders: true, routes: false })).toBe('boulders');
    expect(getClimbTypeFilter({ boulders: false, routes: true })).toBe('routes');
    expect(getClimbTypeFilter({ boulders: true, routes: true })).toBe('both');
  });

  it('defaults to boulders-only when the flags are undefined', () => {
    expect(getClimbTypeFilter({})).toBe('boulders');
  });

  it('treats both-off as "both" (no frames_count constraint)', () => {
    expect(getClimbTypeFilter({ boulders: false, routes: false })).toBe('both');
  });
});
