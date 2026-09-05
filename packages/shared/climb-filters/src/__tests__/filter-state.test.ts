import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  hasActiveClimbFilters,
  statusToFlags,
  flagsToStatus,
  applyStatusChange,
  toClimbSearchInput,
  newSortSeed,
  type ClimbFilterState,
  type BoardSearchConfig,
  type SearchPagination,
  type StatusFilter,
} from '../filter-state';

const board: BoardSearchConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
};

const pagination: SearchPagination = { page: 0, pageSize: 30 };

describe('DEFAULT_CLIMB_FILTER_STATE', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_CLIMB_FILTER_STATE).toEqual({
      sortBy: 'ascents',
      sortOrder: 'desc',
      status: 'any',
      boulders: true,
      routes: false,
    });
  });
});

describe('hasActiveClimbFilters', () => {
  it('returns false for the default state', () => {
    expect(hasActiveClimbFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
  });

  it('returns true when sortBy differs from default', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, sortBy: 'quality' })).toBe(true);
  });

  it('returns true when sortOrder differs from default', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, sortOrder: 'asc' })).toBe(true);
  });

  it('returns true when status differs from default', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' })).toBe(true);
  });

  it.each([
    ['minGrade', { minGrade: 10 }],
    ['maxGrade', { maxGrade: 20 }],
    ['minAscents', { minAscents: 5 }],
    ['minRating', { minRating: 3 }],
    ['gradeAccuracy', { gradeAccuracy: '0.1' as const }],
    ['setter', { setter: ['alice'] }],
    ['onlyTallClimbs', { onlyTallClimbs: true }],
    ['onlyWideClimbs', { onlyWideClimbs: true }],
    ['onlyWithBetaVideos', { onlyWithBetaVideos: true }],
    ['hideAttempted', { hideAttempted: true }],
    ['hideCompleted', { hideCompleted: true }],
    ['showOnlyAttempted', { showOnlyAttempted: true }],
    ['showOnlyCompleted', { showOnlyCompleted: true }],
  ])('returns true when %s is set', (_label, overrides) => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, ...overrides })).toBe(true);
  });

  it('returns false when setter is an empty array', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, setter: [] })).toBe(false);
  });
});

describe('statusToFlags / flagsToStatus', () => {
  it('maps drafts to onlyDrafts flag', () => {
    expect(statusToFlags('drafts')).toEqual({ onlyDrafts: true });
  });

  it('maps projects to projectsOnly flag', () => {
    expect(statusToFlags('projects')).toEqual({ projectsOnly: true });
  });

  it('maps any to empty flags', () => {
    expect(statusToFlags('any')).toEqual({});
  });

  it('maps established to empty flags', () => {
    expect(statusToFlags('established')).toEqual({});
  });

  it.each<StatusFilter>(['drafts', 'projects', 'any'])('roundtrips %s through flags', (status) => {
    expect(flagsToStatus(statusToFlags(status))).toBe(status);
  });

  it('flagsToStatus returns any for empty flags', () => {
    expect(flagsToStatus({})).toBe('any');
  });

  it('flagsToStatus prefers drafts when both flags set', () => {
    expect(flagsToStatus({ onlyDrafts: true, projectsOnly: true })).toBe('drafts');
  });
});

describe('newSortSeed', () => {
  it('returns a positive integer string within the 31-bit range', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const seed = newSortSeed();
      expect(seed).toMatch(/^\d+$/);
      const value = Number(seed);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(2147483647);
    }
  });
});

describe('toClimbSearchInput', () => {
  it('produces a minimal search input for the default state', () => {
    expect(toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      page: 0,
      pageSize: 30,
      sortBy: 'ascents',
      sortOrder: 'desc',
      // Default is boulders-only (routes hidden), matching web.
      boulders: true,
    });
  });

  it('copies defined optional fields onto the input', () => {
    const state: ClimbFilterState = {
      ...DEFAULT_CLIMB_FILTER_STATE,
      minGrade: 10,
      maxGrade: 20,
      minAscents: 5,
      minRating: 3,
      gradeAccuracy: '0.1',
      onlyTallClimbs: true,
      onlyWideClimbs: true,
      onlyWithBetaVideos: true,
      hideAttempted: true,
      hideCompleted: true,
      showOnlyAttempted: true,
      showOnlyCompleted: true,
    };

    const result = toClimbSearchInput(state, board, pagination);

    expect(result).toMatchObject({
      minGrade: 10,
      maxGrade: 20,
      minAscents: 5,
      minRating: 3,
      gradeAccuracy: '0.1',
      onlyTallClimbs: true,
      onlyWideClimbs: true,
      onlyWithBetaVideos: true,
      hideAttempted: true,
      hideCompleted: true,
      showOnlyAttempted: true,
      showOnlyCompleted: true,
    });
  });

  it('threads the random sort seed only when sorting randomly', () => {
    const withSeed = toClimbSearchInput(
      { ...DEFAULT_CLIMB_FILTER_STATE, sortBy: 'random', sortSeed: '4242' },
      board,
      pagination,
    );
    expect(withSeed).toMatchObject({ sortBy: 'random', sortSeed: '4242' });

    // A stale seed on a non-random sort is dropped.
    const nonRandom = toClimbSearchInput(
      { ...DEFAULT_CLIMB_FILTER_STATE, sortBy: 'quality', sortSeed: '4242' },
      board,
      pagination,
    );
    expect(nonRandom.sortSeed).toBeUndefined();
  });

  it('maps status=drafts to onlyDrafts', () => {
    const result = toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, status: 'drafts' }, board, pagination);
    expect(result.onlyDrafts).toBe(true);
    expect(result.projectsOnly).toBeUndefined();
  });

  it('maps status=projects to projectsOnly', () => {
    const result = toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, status: 'projects' }, board, pagination);
    expect(result.projectsOnly).toBe(true);
    expect(result.onlyDrafts).toBeUndefined();
  });

  it('omits status flags for status=any and status=established', () => {
    const anyResult = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination);
    expect(anyResult.onlyDrafts).toBeUndefined();
    expect(anyResult.projectsOnly).toBeUndefined();

    const establishedResult = toClimbSearchInput(
      { ...DEFAULT_CLIMB_FILTER_STATE, status: 'established' },
      board,
      pagination,
    );
    expect(establishedResult.onlyDrafts).toBeUndefined();
    expect(establishedResult.projectsOnly).toBeUndefined();
  });

  it('passes setter array when non-empty', () => {
    const result = toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, setter: ['alice', 'bob'] }, board, pagination);
    expect(result.setter).toEqual(['alice', 'bob']);
  });

  it('omits setter when array is empty', () => {
    const result = toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, setter: [] }, board, pagination);
    expect(result.setter).toBeUndefined();
  });

  it('includes name when provided in options', () => {
    const result = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination, { name: 'crimp' });
    expect(result.name).toBe('crimp');
  });

  it('omits name when options.name is empty string', () => {
    const result = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination, { name: '' });
    expect(result.name).toBeUndefined();
  });

  it('omits name when options is undefined', () => {
    const result = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination);
    expect(result.name).toBeUndefined();
  });

  it('preserves board and pagination fields verbatim', () => {
    const result = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, { page: 3, pageSize: 100 });
    expect(result.boardName).toBe('kilter');
    expect(result.layoutId).toBe(1);
    expect(result.sizeId).toBe(10);
    expect(result.setIds).toBe('1,20');
    expect(result.angle).toBe(40);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(100);
  });
});

describe('GRADE_ACCURACY_VALUES ordering', () => {
  it('iterates in UX progression: off, loose, moderate, tight', async () => {
    // Smaller numeric value = stricter accuracy. The UI consumes this list
    // directly to render the radio, so the order matters.
    const { GRADE_ACCURACY_VALUES } = await import('../filter-state');
    expect([...GRADE_ACCURACY_VALUES]).toEqual(['0', '0.2', '0.1', '0.05']);
  });
});

describe('applyStatusChange', () => {
  it('drafts: sets onlyDrafts intent, clears minAscents, switches sort to newest', () => {
    const previous: ClimbFilterState = { ...DEFAULT_CLIMB_FILTER_STATE, minAscents: 25 };
    expect(applyStatusChange(previous, 'drafts')).toEqual({
      status: 'drafts',
      minAscents: undefined,
      sortBy: 'creation',
      sortOrder: 'desc',
    });
  });

  it('established: sets minAscents to 2 (parity with web)', () => {
    expect(applyStatusChange(DEFAULT_CLIMB_FILTER_STATE, 'established')).toEqual({
      status: 'established',
      minAscents: 2,
    });
  });

  it('projects: clears minAscents', () => {
    const previous: ClimbFilterState = { ...DEFAULT_CLIMB_FILTER_STATE, minAscents: 50 };
    expect(applyStatusChange(previous, 'projects')).toEqual({
      status: 'projects',
      minAscents: undefined,
    });
  });

  it('any: clears minAscents (including the established=2 leftover)', () => {
    const previous: ClimbFilterState = { ...DEFAULT_CLIMB_FILTER_STATE, status: 'established', minAscents: 2 };
    expect(applyStatusChange(previous, 'any')).toEqual({
      status: 'any',
      minAscents: undefined,
    });
  });

  it('produces a patch that, when applied to established, flows minAscents=2 through toClimbSearchInput', () => {
    const patched: ClimbFilterState = {
      ...DEFAULT_CLIMB_FILTER_STATE,
      ...applyStatusChange(DEFAULT_CLIMB_FILTER_STATE, 'established'),
    };
    const input = toClimbSearchInput(patched, board, pagination);
    expect(input.minAscents).toBe(2);
  });
});

describe('personal rating filters (#2645)', () => {
  it('counts a star minimum and the rated-by-me switch as active filters', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, minUserRating: 4 })).toBe(true);
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, onlyRatedByMe: true })).toBe(true);
  });

  it('forwards both to the search input', () => {
    const state: ClimbFilterState = { ...DEFAULT_CLIMB_FILTER_STATE, minUserRating: 4, onlyRatedByMe: true };
    const input = toClimbSearchInput(state, board, pagination);

    expect(input.minUserRating).toBe(4);
    expect(input.onlyRatedByMe).toBe(true);
  });

  it('omits both when unset, so an unfiltered search stays anonymous and cacheable', () => {
    const input = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, pagination);

    expect(input.minUserRating).toBeUndefined();
    expect(input.onlyRatedByMe).toBeUndefined();
    expect('minUserRating' in input).toBe(false);
    expect('onlyRatedByMe' in input).toBe(false);
  });
});

// #4796 / #4828: the climber's own grade drives the grade range and the
// difficulty sort, but only where it can change the answer — the param is
// user-specific, so sending it needlessly costs the Redis cache on the app's
// busiest query.
describe('toClimbSearchInput personal grades', () => {
  const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
  const pagination = { page: 0, pageSize: 20 };
  const build = (state: Partial<ClimbFilterState>, personalGrades: boolean) =>
    toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, ...state }, board, pagination, { personalGrades });

  it('stays off for a plain browse even when personal grades are enabled', () => {
    expect(build({}, true).useMyGrades).toBeUndefined();
  });

  it('turns on for a grade-bounded search', () => {
    expect(build({ minGrade: 24 }, true).useMyGrades).toBe(true);
    expect(build({ maxGrade: 28 }, true).useMyGrades).toBe(true);
  });

  it('turns on for a difficulty sort, which has no grade bounds of its own', () => {
    expect(build({ sortBy: 'difficulty' }, true).useMyGrades).toBe(true);
  });

  it('stays off entirely when the kill switch is off', () => {
    expect(build({ minGrade: 24 }, false).useMyGrades).toBeUndefined();
    expect(build({ sortBy: 'difficulty' }, false).useMyGrades).toBeUndefined();
  });
});
