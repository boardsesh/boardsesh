import { describe, it, expect } from 'vite-plus/test';
import { CLIMB_TYPE_VALUES, climbTypePatch, getClimbTypeFilter } from '../climb-type-filter';
import { DEFAULT_CLIMB_FILTER_STATE } from '../filter-state';
import { DEFAULT_PLAYLIST_VIEW_STATE, PLAYLIST_SORT_OPTIONS } from '../playlist-view';
import { playlistSortPatch, sortKeyPatch } from '../sort-patches';

describe('sortKeyPatch', () => {
  it('mints a fresh seed for Random, so every tap is a new shuffle', () => {
    const first = sortKeyPatch('random');
    expect(first.sortBy).toBe('random');
    expect(first.sortSeed).toMatch(/^\d+$/);
    const seeds = new Set(Array.from({ length: 20 }, () => sortKeyPatch('random').sortSeed));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('clears the seed for every other key and leaves the direction alone', () => {
    expect(sortKeyPatch('difficulty')).toEqual({ sortBy: 'difficulty', sortSeed: undefined });
    expect(sortKeyPatch('difficulty')).not.toHaveProperty('sortOrder');
  });
});

describe('playlistSortPatch', () => {
  it('opens each key on its own direction', () => {
    expect(playlistSortPatch('position')).toEqual({ sortBy: 'position', sortOrder: 'asc' });
    expect(playlistSortPatch('difficulty')).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    expect(playlistSortPatch('name')).toEqual({ sortBy: 'name', sortOrder: 'asc' });
    expect(playlistSortPatch('added')).toEqual({ sortBy: 'added', sortOrder: 'desc' });
    expect(playlistSortPatch('quality')).toEqual({ sortBy: 'quality', sortOrder: 'desc' });
    expect(playlistSortPatch('ascents')).toEqual({ sortBy: 'ascents', sortOrder: 'desc' });
  });

  it('gives Random a seed and no other key one', () => {
    for (const sortBy of PLAYLIST_SORT_OPTIONS) {
      const sort = playlistSortPatch(sortBy);
      if (sortBy === 'random') expect(sort.sortSeed).toMatch(/^\d+$/);
      else expect(sort).not.toHaveProperty('sortSeed');
    }
  });
});

describe('climb type single-select', () => {
  it('lists boulders, routes and both, in that order', () => {
    expect(CLIMB_TYPE_VALUES).toEqual(['boulders', 'routes', 'both']);
  });

  it('writes both flags for every pick, and reads each pick back', () => {
    expect(climbTypePatch('boulders')).toEqual({ boulders: true, routes: false });
    expect(climbTypePatch('routes')).toEqual({ boulders: false, routes: true });
    expect(climbTypePatch('both')).toEqual({ boulders: true, routes: true });
    for (const value of CLIMB_TYPE_VALUES) {
      expect(getClimbTypeFilter(climbTypePatch(value))).toBe(value);
      expect(getClimbTypeFilter(climbTypePatch(value), DEFAULT_PLAYLIST_VIEW_STATE)).toBe(value);
    }
  });

  it('reads unset flags as the Climbs default (boulders only) unless the list passes its own', () => {
    expect(getClimbTypeFilter({})).toBe('boulders');
    expect(getClimbTypeFilter({}, DEFAULT_CLIMB_FILTER_STATE)).toBe('boulders');
    expect(getClimbTypeFilter({}, DEFAULT_PLAYLIST_VIEW_STATE)).toBe('both');
  });

  it('reads both off as both, the no-constraint pick', () => {
    expect(getClimbTypeFilter({ boulders: false, routes: false })).toBe('both');
  });
});
