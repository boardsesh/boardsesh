import { describe, expect, it } from 'vitest';
import type { ActiveBoard } from '../board/active-board';
import { DEFAULT_CLIMB_FILTERS, buildSearchInput, countActiveFilters, listsClimb, withSort } from './climb-filters';

const board: ActiveBoard = {
  boardName: 'moonboard',
  layoutId: 2,
  sizeId: 1,
  setIds: [2, 3],
  angle: 40,
  name: 'MoonBoard 2016',
};

describe('buildSearchInput', () => {
  it('searches the active board, boulders only, most sent first', () => {
    const input = buildSearchInput(board, DEFAULT_CLIMB_FILTERS, { name: '', page: 0, signedIn: true });
    expect(input).toMatchObject({
      boardName: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3',
      angle: 40,
      page: 0,
      pageSize: 30,
      sortBy: 'ascents',
      sortOrder: 'desc',
      boulders: true,
    });
    expect(input.name).toBeUndefined();
    expect(input.onlyBenchmarks).toBeUndefined();
  });

  it('maps grades, stars, benchmarks and the name search', () => {
    const input = buildSearchInput(
      board,
      { ...DEFAULT_CLIMB_FILTERS, minGrade: 18, maxGrade: 21, minStars: 3, benchmarksOnly: true },
      { name: '  crimp ', page: 2, signedIn: true },
    );
    expect(input).toMatchObject({
      minGrade: 18,
      maxGrade: 21,
      minRating: 3,
      onlyBenchmarks: true,
      name: 'crimp',
      page: 2,
    });
  });

  it('sorts by grade among climbs someone has repeated', () => {
    for (const sort of ['easiest', 'hardest'] as const) {
      const input = buildSearchInput(board, withSort(DEFAULT_CLIMB_FILTERS, sort), {
        name: '',
        page: 0,
        signedIn: false,
      });
      expect(input).toMatchObject({ sortBy: 'difficulty', minAscents: 1 });
    }
    expect(
      buildSearchInput(board, DEFAULT_CLIMB_FILTERS, { name: '', page: 0, signedIn: false }).minAscents,
    ).toBeUndefined();
  });

  it('keeps the odd ungraded climb out of a grade sort only', () => {
    const easiest = withSort(DEFAULT_CLIMB_FILTERS, 'easiest');
    expect(listsClimb(easiest, { difficulty: '' })).toBe(false);
    expect(listsClimb(easiest, { difficulty: '6c/V5' })).toBe(true);
    expect(listsClimb(DEFAULT_CLIMB_FILTERS, { difficulty: '' })).toBe(true);
  });

  it('searches setters by their climbs instead of by name', () => {
    const input = buildSearchInput(board, DEFAULT_CLIMB_FILTERS, {
      name: 'crim',
      page: 0,
      signedIn: false,
      setters: ['crim88'],
    });
    expect(input.setter).toEqual(['crim88']);
    expect(input.name).toBeUndefined();
  });

  it('hides sent climbs only for a signed-in climber', () => {
    const filters = { ...DEFAULT_CLIMB_FILTERS, hideSent: true };
    expect(buildSearchInput(board, filters, { name: '', page: 0, signedIn: true }).hideCompleted).toBe(true);
    expect(buildSearchInput(board, filters, { name: '', page: 0, signedIn: false }).hideCompleted).toBeUndefined();
  });

  it('keeps a shuffle stable by sending its seed', () => {
    const shuffled = withSort(DEFAULT_CLIMB_FILTERS, 'random');
    expect(shuffled.shuffleSeed).not.toBeNull();
    const input = buildSearchInput(board, shuffled, { name: '', page: 1, signedIn: false });
    expect(input.sortBy).toBe('random');
    expect(input.sortSeed).toBe(shuffled.shuffleSeed);
    expect(withSort(shuffled, 'hardest').shuffleSeed).toBeNull();
  });

  it('counts the filters that narrow the list', () => {
    expect(countActiveFilters(DEFAULT_CLIMB_FILTERS)).toBe(0);
    expect(
      countActiveFilters({ ...DEFAULT_CLIMB_FILTERS, minGrade: 18, maxGrade: 20, hideSent: true, sort: 'hardest' }),
    ).toBe(2);
  });
});
