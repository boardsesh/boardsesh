import { describe, expect, it } from 'vitest';
import type { ClimbFilters } from '../climb-filter-types';
import type { RecentFilter } from '../recent-filter-store';
import { recentFiltersForBoard } from '../recent-filters-for-board';

const KILTER = 'kilter|1|10|1,20';
const TENSION = 'tension|10|6|12';
const base: ClimbFilters = { sortBy: 'ascents', sortOrder: 'desc', status: 'any' };
const v3: ClimbFilters = { ...base, minGrade: 16, maxGrade: 17 };

function recent(id: string, filters: ClimbFilters, searchText: string, boardKey?: string): RecentFilter {
  return { id, label: `${id} label`, filters, searchText, timestamp: 0, boardKey };
}

const relabel = (filters: ClimbFilters) => `relabelled ${filters.minGrade ?? 'none'}`;

describe('recentFiltersForBoard', () => {
  it('returns the same list when every entry applies as saved', () => {
    const recents = [recent('a', v3, 'crimp', KILTER), recent('b', v3, '', TENSION), recent('c', v3, 'old')];
    expect(recentFiltersForBoard(recents, KILTER, relabel)).toBe(recents);
  });

  it('keeps the name on the board it was typed on', () => {
    const recents = [recent('a', v3, 'crimp', KILTER)];
    expect(recentFiltersForBoard(recents, KILTER, relabel)[0]?.searchText).toBe('crimp');
  });

  it('drops the name on another board and relabels the search', () => {
    const [entry] = recentFiltersForBoard([recent('a', v3, 'crimp', KILTER)], TENSION, relabel);
    expect(entry).toMatchObject({ id: 'a', filters: v3, searchText: '', label: 'relabelled 16' });
  });

  it('leaves out a name-only search from another board', () => {
    expect(recentFiltersForBoard([recent('a', base, 'crimp', KILTER)], TENSION, relabel)).toEqual([]);
  });

  it('keeps only the newer of two searches that become the same', () => {
    const recents = [recent('newer', v3, 'crimp', KILTER), recent('older', v3, '', TENSION)];
    expect(recentFiltersForBoard(recents, TENSION, relabel).map((entry) => entry.id)).toEqual(['newer']);
  });

  it('keeps the name on entries saved before boards were recorded', () => {
    const recents = [recent('legacy', v3, 'crimp'), recent('a', v3, 'jugs', KILTER)];
    const result = recentFiltersForBoard(recents, TENSION, relabel);
    expect(result.map((entry) => [entry.id, entry.searchText])).toEqual([
      ['legacy', 'crimp'],
      ['a', ''],
    ]);
  });
});
