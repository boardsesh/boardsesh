import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import {
  climbFilterSessionReducer,
  createClimbFilterSessionState,
  type ClimbFilterSessionState,
  type SessionSort,
} from '../climb-filter-session-reducer';
import { PLAYLIST_FILTER_DEFAULTS } from '../playlists/playlist-view';

type Key = 'position' | 'difficulty' | 'random';
const DEFAULT_SORT: SessionSort<Key> = { sortBy: 'position', sortOrder: 'asc' };
const HARDEST_FIRST: SessionSort<Key> = { sortBy: 'difficulty', sortOrder: 'desc' };

function freshState(initialSort: SessionSort<Key> = DEFAULT_SORT): ClimbFilterSessionState<Key> {
  return createClimbFilterSessionState<Key>({
    defaultFilters: PLAYLIST_FILTER_DEFAULTS,
    defaultSort: DEFAULT_SORT,
    initialSort,
  });
}

/** A playlist with a sort, a grade band, a benchmark filter, a name and "fits my board". */
function busyState(): ClimbFilterSessionState<Key> {
  let state = freshState(HARDEST_FIRST);
  state = climbFilterSessionReducer(state, { type: 'patchFilters', patch: { minGrade: 12, maxGrade: 14 } });
  state = climbFilterSessionReducer(state, { type: 'collection', value: 'benchmarks' });
  state = climbFilterSessionReducer(state, { type: 'setName', name: 'crimp' });
  return climbFilterSessionReducer(state, { type: 'setBoardFit', boardFit: true });
}

describe('climbFilterSessionReducer', () => {
  it('starts from the list defaults with the remembered sort', () => {
    const state = freshState(HARDEST_FIRST);
    expect(state.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(state.boardFilters).toBe(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    expect(state.sort).toEqual(HARDEST_FIRST);
    expect(state.name).toBe('');
    expect(state.boardFit).toBe(false);
  });

  it('Clear filters drops every filter and keeps the sort', () => {
    const cleared = climbFilterSessionReducer(busyState(), { type: 'clearFilters' });
    expect(cleared.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(cleared.boardFilters).toBe(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    expect(cleared.name).toBe('');
    expect(cleared.boardFit).toBe(false);
    expect(cleared.sort).toEqual(HARDEST_FIRST);
  });

  it('Clear filters on a clear list changes nothing, so nothing re-renders', () => {
    const state = freshState(HARDEST_FIRST);
    expect(climbFilterSessionReducer(state, { type: 'clearFilters' })).toBe(state);
  });

  it('Reset puts everything back, the sort included', () => {
    const reset = climbFilterSessionReducer(busyState(), { type: 'resetToDefault' });
    expect(reset.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(reset.name).toBe('');
    expect(reset.boardFit).toBe(false);
    expect(reset.sort).toEqual(DEFAULT_SORT);
  });

  it('puts the filters sort fields back on the inert defaults on every write', () => {
    const fromSheet = climbFilterSessionReducer(freshState(), {
      type: 'replaceSelection',
      filters: { ...PLAYLIST_FILTER_DEFAULTS, sortBy: 'difficulty', sortOrder: 'asc', sortSeed: '7', minRating: 3 },
      boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    });
    expect(fromSheet.filters).toEqual({ ...PLAYLIST_FILTER_DEFAULTS, minRating: 3 });
    expect(fromSheet.filters).not.toHaveProperty('sortSeed');

    const fromPatch = climbFilterSessionReducer(freshState(), {
      type: 'patchFilters',
      patch: { sortBy: 'random', sortSeed: '9' },
    });
    expect(fromPatch.filters.sortBy).toBe(PLAYLIST_FILTER_DEFAULTS.sortBy);
    expect(fromPatch.filters.sortOrder).toBe(PLAYLIST_FILTER_DEFAULTS.sortOrder);
    expect(fromPatch.filters).not.toHaveProperty('sortSeed');
  });

  it('changes only the direction for a direction tap, and only the seed for a reshuffle', () => {
    const flipped = climbFilterSessionReducer(freshState(HARDEST_FIRST), { type: 'setSortOrder', sortOrder: 'asc' });
    expect(flipped.sort).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    const shuffled = climbFilterSessionReducer(freshState({ sortBy: 'random', sortOrder: 'asc', sortSeed: '1' }), {
      type: 'reshuffle',
      sortSeed: '2',
    });
    expect(shuffled.sort).toEqual({ sortBy: 'random', sortOrder: 'asc', sortSeed: '2' });
  });

  it('clears a projects status when a popularity bucket is picked, like the Climbs chip', () => {
    let state = climbFilterSessionReducer(freshState(), { type: 'patchFilters', patch: { status: 'projects' } });
    state = climbFilterSessionReducer(state, { type: 'popularity', bucket: 10 });
    expect(state.filters.minAscents).toBe(10);
    expect(state.filters.status).toBe('any');
  });

  it('toggles beta videos on and back off', () => {
    const on = climbFilterSessionReducer(freshState(), { type: 'toggleBeta' });
    expect(on.filters.onlyWithBetaVideos).toBe(true);
    expect(climbFilterSessionReducer(on, { type: 'toggleBeta' }).filters.onlyWithBetaVideos).toBeUndefined();
  });

  it('pausing shows the default view and keeps the sort aside; resuming gives the sort back, not the filters', () => {
    const paused = climbFilterSessionReducer(busyState(), { type: 'pauseView' });
    expect(paused.sort).toEqual(DEFAULT_SORT);
    expect(paused.pausedSort).toEqual(HARDEST_FIRST);
    expect(paused.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(paused.name).toBe('');

    // A second pause keeps the first sort, not the default it now shows.
    const pausedTwice = climbFilterSessionReducer(paused, { type: 'pauseView' });
    expect(pausedTwice.pausedSort).toEqual(HARDEST_FIRST);

    const resumed = climbFilterSessionReducer(pausedTwice, { type: 'resumeView' });
    expect(resumed.sort).toEqual(HARDEST_FIRST);
    expect(resumed.pausedSort).toBeNull();
    expect(resumed.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
  });

  it('resuming without a pause changes nothing', () => {
    const state = freshState(HARDEST_FIRST);
    expect(climbFilterSessionReducer(state, { type: 'resumeView' })).toBe(state);
  });

  it('merges board filter patches from the token row', () => {
    const state = climbFilterSessionReducer(busyState(), {
      type: 'patchBoardFilters',
      patch: { onlyBenchmarks: false },
    });
    expect(state.boardFilters.onlyBenchmarks).toBe(false);
  });

  it('keeps the direction when the key in force is picked again, and reshuffles a shuffling key', () => {
    const hardest = freshState(HARDEST_FIRST);
    expect(
      climbFilterSessionReducer(hardest, {
        type: 'selectSortKey',
        sort: { sortBy: 'difficulty', sortOrder: 'asc' },
        shuffles: false,
      }),
    ).toBe(hardest);
    const switched = climbFilterSessionReducer(hardest, {
      type: 'selectSortKey',
      sort: { sortBy: 'position', sortOrder: 'asc' },
      shuffles: false,
    });
    expect(switched.sort).toEqual(DEFAULT_SORT);
    const shuffled = climbFilterSessionReducer(freshState({ sortBy: 'random', sortOrder: 'asc', sortSeed: '1' }), {
      type: 'selectSortKey',
      sort: { sortBy: 'random', sortOrder: 'asc', sortSeed: '2' },
      shuffles: true,
    });
    expect(shuffled.sort.sortSeed).toBe('2');
  });

  it('decides a re-tap by the shuffle flag, not by whether a seed came along', () => {
    // A shuffling key re-picked without a seed still takes the new sort...
    const random = freshState({ sortBy: 'random', sortOrder: 'asc', sortSeed: '1' });
    const reshuffled = climbFilterSessionReducer(random, {
      type: 'selectSortKey',
      sort: { sortBy: 'random', sortOrder: 'asc' },
      shuffles: true,
    });
    expect(reshuffled).not.toBe(random);
    // ...and a key that does not shuffle keeps its sort even if a seed is attached.
    const hardest = freshState(HARDEST_FIRST);
    expect(
      climbFilterSessionReducer(hardest, {
        type: 'selectSortKey',
        sort: { sortBy: 'difficulty', sortOrder: 'asc', sortSeed: '9' },
        shuffles: false,
      }),
    ).toBe(hardest);
  });
});
