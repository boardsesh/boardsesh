import { describe, it, expect } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE } from '@boardsesh/climb-filters';
import {
  collectionPatch,
  getCollectionFilter,
  getClimbTypeFilter,
  isCollectionFilter,
  isPersonalCollection,
  offersBenchmarksFilter,
  visibleCollectionValues,
  COLLECTION_VALUES,
} from '../collection-filter';

describe('getCollectionFilter', () => {
  it('reads drafts / any from the status flag', () => {
    expect(getCollectionFilter({ status: 'drafts' })).toBe('drafts');
    expect(getCollectionFilter({ status: 'any' })).toBe('any');
  });

  it('treats projects (Unrepeated) as "any" — it belongs to Popularity, not Collection', () => {
    expect(getCollectionFilter({ status: 'projects' })).toBe('any');
  });

  it('reads liked from onlyFavorited (#6002)', () => {
    expect(getCollectionFilter({ status: 'any', onlyFavorited: true })).toBe('liked');
    expect(getCollectionFilter({ status: 'any', onlyFavorited: false })).toBe('any');
  });
});

describe('collectionPatch', () => {
  const apply = (value: Parameters<typeof collectionPatch>[0], filters = DEFAULT_CLIMB_FILTER_STATE) => ({
    ...filters,
    ...collectionPatch(value, filters).filters,
  });

  it('Liked sets onlyFavorited and clears My drafts', () => {
    const fromDrafts = apply('liked', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' });
    expect(fromDrafts.onlyFavorited).toBe(true);
    expect(fromDrafts.status).toBe('any');
    expect(getCollectionFilter(fromDrafts)).toBe('liked');
  });

  it.each(['any', 'drafts'] as const)('%s clears Liked', (value) => {
    const result = apply(value, { ...DEFAULT_CLIMB_FILTER_STATE, onlyFavorited: true });
    expect(result.onlyFavorited).toBeUndefined();
    expect(getCollectionFilter(result)).toBe(value);
  });

  it('Any clears a drafts status but keeps Unrepeated', () => {
    expect(apply('any', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' }).status).toBe('any');
    expect(apply('any', { ...DEFAULT_CLIMB_FILTER_STATE, status: 'projects' }).status).toBe('projects');
  });

  it('never touches the benchmarks switch, so the two combine (#2493)', () => {
    expect(Object.keys(collectionPatch('liked', DEFAULT_CLIMB_FILTER_STATE))).toEqual(['filters']);
  });
});

describe('offersBenchmarksFilter', () => {
  it('offers the switch everywhere but a spray wall, where it stays only while on', () => {
    expect(offersBenchmarksFilter(false, false)).toBe(true);
    expect(offersBenchmarksFilter(true, false)).toBe(false);
    expect(offersBenchmarksFilter(true, true)).toBe(true);
  });
});

describe('isPersonalCollection', () => {
  it('marks My drafts and Liked as needing an account', () => {
    expect(COLLECTION_VALUES.filter(isPersonalCollection)).toEqual(['drafts', 'liked']);
  });
});

describe('isCollectionFilter', () => {
  it('guards the three values and rejects others', () => {
    for (const value of COLLECTION_VALUES) expect(isCollectionFilter(value)).toBe(true);
    expect(isCollectionFilter('benchmarks')).toBe(false);
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
  it('offers My drafts and Liked when signed in', () => {
    expect(visibleCollectionValues({ canFilterPersonalCollections: true, isSprayWall: false })).toEqual([
      'any',
      'drafts',
      'liked',
    ]);
  });
  it('drops My drafts and Liked when signed out', () => {
    expect(visibleCollectionValues({ canFilterPersonalCollections: false, isSprayWall: false })).toEqual(['any']);
  });
  it("keeps a spray wall's drafts signed out", () => {
    expect(visibleCollectionValues({ canFilterPersonalCollections: false, isSprayWall: true })).toEqual([
      'any',
      'drafts',
    ]);
  });
});
