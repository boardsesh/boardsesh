import { describe, it, expect } from 'vitest';
import { SETTER_FILTER_DEFAULTS, setterPlaylistInput } from '../setter-playlist-input';
import { DEFAULT_SETTER_SORT, type SetterSelection } from '../setter-sort-model';

function selection(overrides: Partial<SetterSelection> = {}): SetterSelection {
  return {
    filters: SETTER_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: DEFAULT_SETTER_SORT,
    boardFit: false,
    ...overrides,
  };
}

const woodsBoard = { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 };
const kilterBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

describe('setterPlaylistInput', () => {
  it('asks for every angle on Woods, so the page lists the whole catalogue (#5642)', () => {
    expect(setterPlaylistInput('marco', woodsBoard).crossAngleStats).toBe(true);
  });

  it('leaves the cross-angle opt-in off on Kilter, where it is the slow query', () => {
    expect(setterPlaylistInput('marco', kilterBoard)).not.toHaveProperty('crossAngleStats');
  });

  it('scopes to the setter and the board it was built for', () => {
    expect(setterPlaylistInput('marco', woodsBoard)).toMatchObject({
      ...woodsBoard,
      setter: ['marco'],
      sortBy: 'creation',
      sortOrder: 'desc',
    });
  });

  describe('under a view (#6651)', () => {
    it('sends exactly the input from before views with no view, or the page order with nothing filtered', () => {
      const plain = setterPlaylistInput('marco', kilterBoard);
      expect(plain).toEqual({
        ...kilterBoard,
        setter: ['marco'],
        sortBy: 'creation',
        sortOrder: 'desc',
        boulders: true,
        routes: true,
      });
      expect(setterPlaylistInput('marco', kilterBoard, { selection: selection() })).toEqual(plain);
    });

    it('carries the sort, the filters, the board filters and the name, with no page fields', () => {
      const input = setterPlaylistInput('marco', kilterBoard, {
        selection: selection({
          sort: { sortBy: 'difficulty', sortOrder: 'desc' },
          filters: { ...SETTER_FILTER_DEFAULTS, minGrade: 12, maxGrade: 16, minRating: 3 },
          boardFilters: { holdsFilter: { '7': { HAND: 'include' } } },
          name: '  crimp ',
        }),
        personalGrades: true,
      });
      expect(input).toMatchObject({
        ...kilterBoard,
        setter: ['marco'],
        sortBy: 'difficulty',
        sortOrder: 'desc',
        minGrade: 12,
        maxGrade: 16,
        minRating: 3,
        holdsFilter: { '7': { HAND: 'include' } },
        name: 'crimp',
        useMyGrades: true,
      });
      expect(input).not.toHaveProperty('page');
      expect(input).not.toHaveProperty('pageSize');
    });

    it('keeps the setter pinned whatever the selection says, and drops Other angles on Kilter', () => {
      const input = setterPlaylistInput('marco', kilterBoard, {
        selection: selection({
          sort: { sortBy: 'name', sortOrder: 'asc' },
          filters: { ...SETTER_FILTER_DEFAULTS, setter: ['someone-else'], includeOtherAngles: true },
        }),
      });
      expect(input.setter).toEqual(['marco']);
      expect(input).not.toHaveProperty('crossAngleStats');
    });

    it('keeps every angle on Woods under a view too', () => {
      const input = setterPlaylistInput('marco', woodsBoard, {
        selection: selection({ sort: { sortBy: 'quality', sortOrder: 'desc' } }),
      });
      expect(input.crossAngleStats).toBe(true);
    });

    it('sends the seed for a shuffle', () => {
      const input = setterPlaylistInput('marco', kilterBoard, {
        selection: selection({ sort: { sortBy: 'random', sortOrder: 'asc', sortSeed: '42' } }),
      });
      expect(input).toMatchObject({ sortBy: 'random', sortSeed: '42' });
    });
  });
});
