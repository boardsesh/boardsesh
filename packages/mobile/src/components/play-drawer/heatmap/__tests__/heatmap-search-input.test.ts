import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import { DEFAULT_FILTERS } from '../../../../lib/climb-filter-types';
import { heatmapSearchInput, isHeatmapSearchFiltered, type HeatmapSearch } from '../heatmap-search-input';

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
