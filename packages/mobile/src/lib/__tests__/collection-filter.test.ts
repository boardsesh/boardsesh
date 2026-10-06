import { describe, it, expect } from 'vitest';
import {
  getCollectionFilter,
  getClimbTypeFilter,
  isCollectionFilter,
  visibleCollectionValues,
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
});

describe('isCollectionFilter', () => {
  it('guards the three values and rejects others', () => {
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

describe('visibleCollectionValues', () => {
  it('offers all three values on a board with benchmarks', () => {
    expect(visibleCollectionValues({ canFilterDrafts: true, isSprayWall: false, current: 'any' })).toEqual([
      'any',
      'benchmarks',
      'drafts',
    ]);
  });
  it('drops Benchmarks on a spray wall (#5960)', () => {
    expect(visibleCollectionValues({ canFilterDrafts: true, isSprayWall: true, current: 'any' })).toEqual([
      'any',
      'drafts',
    ]);
  });
  it('keeps an active Benchmarks on a spray wall so it can be undone', () => {
    expect(visibleCollectionValues({ canFilterDrafts: false, isSprayWall: true, current: 'benchmarks' })).toEqual([
      'any',
      'benchmarks',
    ]);
  });
  it('drops My drafts when signed out', () => {
    expect(visibleCollectionValues({ canFilterDrafts: false, isSprayWall: false, current: 'any' })).toEqual([
      'any',
      'benchmarks',
    ]);
  });
});
