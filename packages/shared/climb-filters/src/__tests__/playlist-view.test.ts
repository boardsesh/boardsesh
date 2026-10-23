import { describe, it, expect } from 'vitest';
import { countActiveFilters, countActiveFiltersBeyondGrade } from '../active-filter-count';
import { DEFAULT_CLIMB_FILTER_STATE, hasActiveClimbFilters, toClimbSearchInput } from '../filter-state';
import {
  DEFAULT_PLAYLIST_VIEW_STATE,
  PLAYLIST_SORT_DEFAULT_ORDER,
  PLAYLIST_SORT_OPTIONS,
  countActivePlaylistFilters,
  hasActivePlaylistFilters,
  hasActivePlaylistView,
  PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS,
  toPlaylistClimbViewInput,
  withoutPlaylistActiveBoardOnlyFilters,
  type PlaylistClimbViewState,
} from '../playlist-view';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const pagination = { page: 0, pageSize: 20 };

describe('playlist sort options', () => {
  it('opens on the playlist order and drops the Climbs-only Popular and Newest sorts', () => {
    expect(PLAYLIST_SORT_OPTIONS[0]).toBe('position');
    expect(PLAYLIST_SORT_OPTIONS).not.toContain('popular');
    expect(PLAYLIST_SORT_OPTIONS).not.toContain('creation');
  });

  it('gives every sort a starting direction, difficulty opening on easiest first', () => {
    for (const sortBy of PLAYLIST_SORT_OPTIONS) {
      expect(['asc', 'desc']).toContain(PLAYLIST_SORT_DEFAULT_ORDER[sortBy]);
    }
    expect(PLAYLIST_SORT_DEFAULT_ORDER.difficulty).toBe('asc');
    expect(PLAYLIST_SORT_DEFAULT_ORDER.added).toBe('desc');
  });
});

describe('DEFAULT_PLAYLIST_VIEW_STATE', () => {
  it('keeps both climb types and the playlist order', () => {
    expect(DEFAULT_PLAYLIST_VIEW_STATE).toEqual({
      sortBy: 'position',
      sortOrder: 'asc',
      status: 'any',
      boulders: true,
      routes: true,
    });
  });

  it('reads as no filter against its own defaults, but as a filter against the Climbs defaults', () => {
    // The point of the `defaults` parameter: routes on is the playlist default.
    const withClimbsSort = { ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'ascents', sortOrder: 'desc' as const };
    expect(hasActiveClimbFilters(withClimbsSort)).toBe(true);
    expect(hasActiveClimbFilters(DEFAULT_PLAYLIST_VIEW_STATE, DEFAULT_PLAYLIST_VIEW_STATE)).toBe(false);
    expect(countActiveFilters(DEFAULT_PLAYLIST_VIEW_STATE, undefined, DEFAULT_PLAYLIST_VIEW_STATE)).toBe(0);
  });
});

describe('the defaults parameter leaves the Climbs list alone', () => {
  it('counts exactly what it counted before when no defaults are passed', () => {
    const routesOn = { ...DEFAULT_CLIMB_FILTER_STATE, routes: true };
    expect(hasActiveClimbFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
    expect(hasActiveClimbFilters(routesOn)).toBe(true);
    expect(countActiveFiltersBeyondGrade(routesOn)).toBe(1);
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, sortBy: 'difficulty' })).toBe(1);
  });

  it('treats an unset climb-type toggle as the list default', () => {
    const unset = { ...DEFAULT_PLAYLIST_VIEW_STATE, boulders: undefined, routes: undefined };
    expect(hasActiveClimbFilters(unset, DEFAULT_PLAYLIST_VIEW_STATE)).toBe(false);
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, routes: undefined })).toBe(false);
  });
});

describe('hasActivePlaylistFilters / hasActivePlaylistView / countActivePlaylistFilters', () => {
  it('a sort alone is a view but not a filter', () => {
    const sorted: PlaylistClimbViewState = { ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'difficulty' };
    expect(hasActivePlaylistView(sorted)).toBe(true);
    expect(hasActivePlaylistFilters(sorted)).toBe(false);
    expect(countActivePlaylistFilters(sorted)).toBe(0);
  });

  it('a reversed playlist order is a view', () => {
    expect(hasActivePlaylistView({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortOrder: 'desc' })).toBe(true);
  });

  it('counts grade, progress, boulders-only, board filters and board fit once each', () => {
    const state: PlaylistClimbViewState = {
      ...DEFAULT_PLAYLIST_VIEW_STATE,
      sortBy: 'random',
      minGrade: 12,
      maxGrade: 16,
      hideCompleted: true,
      routes: false,
      onlyActiveBoard: true,
    };
    expect(hasActivePlaylistFilters(state)).toBe(true);
    expect(countActivePlaylistFilters(state, { onlyBenchmarks: true })).toBe(5);
  });

  it('a name search or a board filter alone is a filter', () => {
    expect(hasActivePlaylistFilters(DEFAULT_PLAYLIST_VIEW_STATE, undefined, 'crimp')).toBe(true);
    expect(hasActivePlaylistFilters(DEFAULT_PLAYLIST_VIEW_STATE, undefined, '   ')).toBe(false);
    expect(hasActivePlaylistFilters(DEFAULT_PLAYLIST_VIEW_STATE, { zoneBox: null })).toBe(false);
    expect(hasActivePlaylistFilters(DEFAULT_PLAYLIST_VIEW_STATE, { onlyBenchmarks: true })).toBe(true);
  });
});

describe('toPlaylistClimbViewInput', () => {
  it('returns undefined for a fresh playlist, so the request is the one sent before views', () => {
    expect(toPlaylistClimbViewInput(DEFAULT_PLAYLIST_VIEW_STATE)).toBeUndefined();
    expect(toPlaylistClimbViewInput(DEFAULT_PLAYLIST_VIEW_STATE, { personalGrades: true, boardseshGrades: true })).toBe(
      undefined,
    );
  });

  it('sends a sort alone without any filter field', () => {
    expect(toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'difficulty' })).toEqual({
      sortBy: 'difficulty',
      sortOrder: 'asc',
    });
  });

  it('sends the shuffle seed only for the random sort', () => {
    expect(
      toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'random', sortSeed: '42' })?.sortSeed,
    ).toBe('42');
    expect(
      toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'name', sortSeed: '42' })?.sortSeed,
    ).toBeUndefined();
  });

  it('maps the shared filter fields exactly as the Climbs search does', () => {
    const state: PlaylistClimbViewState = {
      ...DEFAULT_PLAYLIST_VIEW_STATE,
      minGrade: 12,
      maxGrade: 16,
      minAscents: 3,
      minRating: 2,
      gradeAccuracy: '0.1',
      setter: ['alex'],
      onlyFollowedAuthors: true,
      onlyTallClimbs: true,
      onlyWideClimbs: true,
      onlyWithBetaVideos: true,
      hideAttempted: true,
      hideCompleted: true,
      minUserRating: 3,
      onlyRatedByMe: true,
      onlyFavorited: true,
      status: 'projects',
    };
    const view = toPlaylistClimbViewInput(state, { name: 'crimp' });
    const search = toClimbSearchInput({ ...state, sortBy: 'ascents' }, board, pagination, { name: 'crimp' });
    const sharedKeys = [
      'minGrade',
      'maxGrade',
      'minAscents',
      'minRating',
      'gradeAccuracy',
      'setter',
      'onlyFollowedAuthors',
      'onlyTallClimbs',
      'onlyWideClimbs',
      'onlyWithBetaVideos',
      'hideAttempted',
      'hideCompleted',
      'minUserRating',
      'onlyRatedByMe',
      'onlyFavorited',
      'projectsOnly',
      'name',
    ] as const;
    for (const key of sharedKeys) {
      expect(view?.[key], key).toEqual(search[key]);
    }
    expect(view?.projectsOnly).toBe(true);
  });

  it('never sends the Climbs-only drafts or cross-angle fields', () => {
    const view = toPlaylistClimbViewInput({
      ...DEFAULT_PLAYLIST_VIEW_STATE,
      minGrade: 12,
      status: 'drafts',
      includeOtherAngles: true,
    });
    expect(view).toMatchObject({ minGrade: 12 });
    expect(view).not.toHaveProperty('onlyDrafts');
    expect(view).not.toHaveProperty('crossAngleStats');
  });

  it('omits both climb types (the default) and sends one alone', () => {
    const minGradeOnly = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, minGrade: 12 });
    expect(minGradeOnly).not.toHaveProperty('boulders');
    expect(minGradeOnly).not.toHaveProperty('routes');

    const bouldersOnly = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, routes: false });
    expect(bouldersOnly).toMatchObject({ boulders: true });
    expect(bouldersOnly).not.toHaveProperty('routes');

    const routesOnly = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, boulders: false });
    expect(routesOnly).toMatchObject({ routes: true });
    expect(routesOnly).not.toHaveProperty('boulders');
  });

  it('sends personal grades and the Boardsesh source only for a grade band or a difficulty sort', () => {
    const options = { personalGrades: true, boardseshGrades: true };
    const nameSort = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'name' }, options);
    expect(nameSort).not.toHaveProperty('useMyGrades');
    expect(nameSort).not.toHaveProperty('gradeSource');

    const difficultySort = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'difficulty' }, options);
    expect(difficultySort).toMatchObject({ useMyGrades: true, gradeSource: 'BOARDSESH' });

    const gradeBand = toPlaylistClimbViewInput({ ...DEFAULT_PLAYLIST_VIEW_STATE, maxGrade: 16 }, options);
    expect(gradeBand).toMatchObject({ useMyGrades: true, gradeSource: 'BOARDSESH' });
  });

  it('folds in the board filters and the board-fit switch', () => {
    const view = toPlaylistClimbViewInput(
      { ...DEFAULT_PLAYLIST_VIEW_STATE, onlyActiveBoard: true },
      {
        boardFilters: {
          onlyBenchmarks: true,
          holdsFilter: { hold_12: { ANY: 'include' } },
          zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
          zoneMode: 'anyHold',
        },
      },
    );
    expect(view).toMatchObject({
      onlyActiveBoard: true,
      onlyBenchmarks: true,
      holdsFilter: { hold_12: { ANY: 'include' } },
      zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
      zoneMode: 'anyHold',
    });
  });
});

describe('Climbs-only levers a playlist view never sends', () => {
  const carriedOver: PlaylistClimbViewState = {
    ...DEFAULT_PLAYLIST_VIEW_STATE,
    includeOtherAngles: true,
    status: 'drafts',
  };

  it('do not count as a filter, so the badge never says "1" over an empty view', () => {
    expect(hasActivePlaylistFilters(carriedOver, { setterId: 7 })).toBe(false);
    expect(hasActivePlaylistView(carriedOver, { setterId: 7 })).toBe(false);
    expect(countActivePlaylistFilters(carriedOver, { setterId: 7 })).toBe(0);
    expect(toPlaylistClimbViewInput(carriedOver, { boardFilters: { setterId: 7 } })).toBeUndefined();
    expect(countActivePlaylistFilters({ ...DEFAULT_PLAYLIST_VIEW_STATE, status: 'established' })).toBe(0);
  });

  it('leave the levers a playlist does send counted', () => {
    expect(
      countActivePlaylistFilters({ ...carriedOver, status: 'projects' }, { setterId: 7, onlyBenchmarks: true }),
    ).toBe(2);
  });
});

describe('active-board-only filters', () => {
  it('names progress, your ratings, Liked, Following, beta, Tall / Wide, holds, zone and "Fits my board"', () => {
    expect([...PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS].sort()).toEqual(
      [
        'hideAttempted',
        'hideCompleted',
        'showOnlyAttempted',
        'showOnlyCompleted',
        'minUserRating',
        'onlyRatedByMe',
        'onlyFavorited',
        'onlyFollowedAuthors',
        'onlyWithBetaVideos',
        'onlyTallClimbs',
        'onlyWideClimbs',
        'holdsFilter',
        'zoneBox',
        'onlyActiveBoard',
      ].sort(),
    );
  });

  it('drops them and keeps every filter that applies to all rows', () => {
    const filters: PlaylistClimbViewState = {
      ...DEFAULT_PLAYLIST_VIEW_STATE,
      hideCompleted: true,
      onlyFavorited: true,
      onlyWithBetaVideos: true,
      minRating: 3,
      minGrade: 12,
    };
    const { filters: kept, boardFilters } = withoutPlaylistActiveBoardOnlyFilters(
      { ...filters, sortBy: 'ascents' },
      { onlyBenchmarks: true, holdsFilter: { '1': { HAND: 'include' } }, zoneBox: null, zoneMode: 'allHolds' },
    );
    expect(kept).toEqual({ ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'ascents', minRating: 3, minGrade: 12 });
    expect(boardFilters).toEqual({ onlyBenchmarks: true });
  });

  it('hands back the same objects when none is set', () => {
    const filters = { ...DEFAULT_PLAYLIST_VIEW_STATE, sortBy: 'ascents' as const, minRating: 3 };
    const boardFilters = { onlyBenchmarks: true };
    const result = withoutPlaylistActiveBoardOnlyFilters(filters, boardFilters);
    expect(result.filters).toBe(filters);
    expect(result.boardFilters).toBe(boardFilters);
  });
});
