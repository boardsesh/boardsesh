import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILTERS } from '../climb-filter-types';
import type { RecentFilter } from '../recent-filter-store';
import { applyRecentFilterById, findCurrentRecentFilter } from '../recent-filter-selection';

const recents: RecentFilter[] = [
  { id: 'crimp', label: '"crimp"', filters: DEFAULT_FILTERS, searchText: 'crimp', timestamp: 2 },
  {
    id: 'beta',
    label: 'Beta only',
    filters: { ...DEFAULT_FILTERS, onlyWithBetaVideos: true },
    searchText: '',
    timestamp: 1,
  },
];

describe('findCurrentRecentFilter', () => {
  it('finds the saved search whose filters and name are in force', () => {
    expect(findCurrentRecentFilter(recents, DEFAULT_FILTERS, 'crimp')?.id).toBe('crimp');
    expect(findCurrentRecentFilter(recents, { ...DEFAULT_FILTERS, onlyWithBetaVideos: true }, '')?.id).toBe('beta');
  });

  it('finds nothing when no saved search matches', () => {
    expect(findCurrentRecentFilter(recents, DEFAULT_FILTERS, 'jugs')).toBeUndefined();
    expect(findCurrentRecentFilter([], DEFAULT_FILTERS, 'crimp')).toBeUndefined();
  });
});

describe('applyRecentFilterById', () => {
  it('applies the saved search with that id, filters and name together', () => {
    const onApplyRecent = vi.fn();
    applyRecentFilterById(recents, 'beta', onApplyRecent);
    expect(onApplyRecent.mock.calls).toEqual([[recents[1].filters, '']]);
  });

  it('does nothing for an id that is no longer saved', () => {
    const onApplyRecent = vi.fn();
    applyRecentFilterById(recents, 'cleared', onApplyRecent);
    expect(onApplyRecent).not.toHaveBeenCalled();
  });
});
