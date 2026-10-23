// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { LOGBOOK_SMART_TYPES, isLogbookSmartType } from '../../smart-playlists';
import { PLAYLIST_FILTER_DEFAULTS } from '../playlist-view';
import { playlistSheetSections } from '../playlist-board-scope';
import {
  SMART_LIST_SORT_OPTIONS,
  smartListHiddenChips,
  smartListSheetSections,
  smartListSortModelFor,
  smartListViewInput,
  smartSortMemoryKey,
  type SmartListSelection,
} from '../smart-list-view';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function selection(overrides: Partial<SmartListSelection> = {}): SmartListSelection {
  return {
    filters: PLAYLIST_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: { sortBy: 'position', sortOrder: 'asc' },
    boardFit: false,
    ...overrides,
  };
}

function restingLabel(type: Parameters<typeof smartListSortModelFor>[0]): string {
  const { result } = renderHook(() => smartListSortModelFor(type).useLabels());
  return result.current.resting;
}

describe('smart list views', () => {
  it('takes a view on the logbook lists only', () => {
    expect(LOGBOOK_SMART_TYPES).toEqual(['LIKED_CLIMBS', 'FIVE_STARS', 'PROJECTS', 'MOST_REPEATED']);
    expect(isLogbookSmartType('RECOMMENDED_FRESH')).toBe(false);
    expect(isLogbookSmartType('not-a-list')).toBe(false);
  });

  it('offers no "Recently added", and opens on the list\'s own order', () => {
    expect(SMART_LIST_SORT_OPTIONS).not.toContain('added');
    for (const type of LOGBOOK_SMART_TYPES) {
      const model = smartListSortModelFor(type);
      expect(model.options).toEqual(SMART_LIST_SORT_OPTIONS);
      expect(model.defaultSort).toEqual({ sortBy: 'position', sortOrder: 'asc' });
      expect(model.hasDirection('position')).toBe(false);
      expect(model.isOption('added')).toBe(false);
    }
  });

  it("names each list's own order for what it is", () => {
    expect(restingLabel('LIKED_CLIMBS')).toBe('mobile.filter.sort.recentlyLiked');
    expect(restingLabel('FIVE_STARS')).toBe('mobile.filter.sort.recentlyClimbed');
    expect(restingLabel('PROJECTS')).toBe('mobile.filter.sort.mostTries');
    expect(restingLabel('MOST_REPEATED')).toBe('mobile.filter.sort.mostTries');
    // Other keys keep their shared names.
    const { result } = renderHook(() => smartListSortModelFor('LIKED_CLIMBS').useLabels());
    expect(result.current.keyLabel('difficulty')).toBe('mobile.filter.sort.difficulty');
    expect(result.current.directionLabel('position', 'asc')).toBe('mobile.filter.sort.recentlyLiked');
  });

  it('hands back the same model for the same list, as the session needs', () => {
    expect(smartListSortModelFor('PROJECTS')).toBe(smartListSortModelFor('PROJECTS'));
    expect(smartListSortModelFor('PROJECTS')).toBe(smartListSortModelFor('MOST_REPEATED'));
  });

  it("turns off the rows each list already passes, on top of a playlist's", () => {
    expect(smartListSheetSections('LIKED_CLIMBS', true)).toEqual({ ...playlistSheetSections(true), liked: false });
    expect(smartListSheetSections('FIVE_STARS', true)).toEqual({ ...playlistSheetSections(true), myRating: false });
    expect(smartListSheetSections('PROJECTS', true)).toEqual({ ...playlistSheetSections(true), progress: false });
    expect(smartListSheetSections('MOST_REPEATED', true)).toEqual(playlistSheetSections(true));
    expect(smartListSheetSections('MOST_REPEATED', false)).toEqual(playlistSheetSections(false));
    expect(smartListSheetSections('FIVE_STARS', false)).toBe(smartListSheetSections('FIVE_STARS', false));
  });

  it('leaves Your progress off the Projects row only', () => {
    expect(smartListHiddenChips('PROJECTS')).toEqual(['progress']);
    expect(smartListHiddenChips('LIKED_CLIMBS')).toEqual([]);
    expect(smartListHiddenChips('PROJECTS')).toBe(smartListHiddenChips('PROJECTS'));
  });

  it('never sends a view for a recommendation, and none for the own order with no filter', () => {
    const hardestFirst = selection({ sort: { sortBy: 'difficulty', sortOrder: 'desc' } });
    expect(smartListViewInput('RECOMMENDED_CROWD_FAVORITES', hardestFirst)).toBeUndefined();
    expect(smartListViewInput('LIKED_CLIMBS', selection())).toBeUndefined();
    expect(smartListViewInput('LIKED_CLIMBS', hardestFirst)).toEqual({ sortBy: 'difficulty', sortOrder: 'desc' });
  });

  it('remembers one sort per list type', () => {
    expect(smartSortMemoryKey('FIVE_STARS')).toBe('smart:FIVE_STARS');
  });
});
