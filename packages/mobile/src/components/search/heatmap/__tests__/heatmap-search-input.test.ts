import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import { DEFAULT_FILTERS } from '../../../../lib/climb-filter-types';
import {
  heatmapSearchInput,
  isHeatmapSearchFiltered,
  withoutHoldPicks,
  type HeatmapSearch,
} from '../heatmap-search-input';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

function search(overrides: Partial<HeatmapSearch> = {}): HeatmapSearch {
  return { filters: DEFAULT_FILTERS, boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE, searchText: '', ...overrides };
}

describe('heatmapSearchInput', () => {
  it('is the default boulder list with no saved search, without paging or sort', () => {
    expect(heatmapSearchInput(board, null)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      boulders: true,
    });
  });

  it("carries the list's filters, name and board filters, but not its sort", () => {
    const input = heatmapSearchInput(
      board,
      search({
        filters: { ...DEFAULT_FILTERS, minGrade: 16, maxGrade: 20, minAscents: 5, sortBy: 'quality', sortOrder: 'asc' },
        boardFilters: { onlyBenchmarks: true },
        searchText: '  crimp ',
      }),
    );

    expect(input).toMatchObject({ minGrade: 16, maxGrade: 20, minAscents: 5, name: 'crimp', onlyBenchmarks: true });
    expect(input).not.toHaveProperty('sortBy');
    expect(input).not.toHaveProperty('page');
  });
});

describe('isHeatmapSearchFiltered', () => {
  it('is false with no search and for a sort-only search', () => {
    expect(isHeatmapSearchFiltered(null)).toBe(false);
    expect(isHeatmapSearchFiltered(search({ filters: { ...DEFAULT_FILTERS, sortBy: 'quality' } }))).toBe(false);
  });

  it('is true for a filter, a board filter or a name', () => {
    expect(isHeatmapSearchFiltered(search({ filters: { ...DEFAULT_FILTERS, minAscents: 5 } }))).toBe(true);
    expect(isHeatmapSearchFiltered(search({ boardFilters: { onlyBenchmarks: true } }))).toBe(true);
    expect(isHeatmapSearchFiltered(search({ searchText: 'crimp' }))).toBe(true);
  });
});

describe('withoutHoldPicks', () => {
  it('drops the hold picks and keeps every other filter', () => {
    const picked = search({
      searchText: 'crimp',
      boardFilters: { onlyBenchmarks: true, holdsFilter: { hold_7: { STARTING: 'include' as const } } },
    });
    const result = withoutHoldPicks(picked);
    expect(result.boardFilters).toEqual({ onlyBenchmarks: true });
    expect(result.searchText).toBe('crimp');
    expect(heatmapSearchInput(board, result).holdsFilter).toBeUndefined();
  });

  it('leaves a holds-only search unfiltered, so the heat covers the whole board', () => {
    const holdsOnly = search({ boardFilters: { holdsFilter: { hold_7: { ANY: 'include' as const } } } });
    expect(isHeatmapSearchFiltered(holdsOnly)).toBe(true);
    expect(isHeatmapSearchFiltered(withoutHoldPicks(holdsOnly))).toBe(false);
  });
});
