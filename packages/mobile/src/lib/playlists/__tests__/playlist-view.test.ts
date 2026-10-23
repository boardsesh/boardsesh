import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  PLAYLIST_FILTER_DEFAULTS,
  hasActiveSessionFilters,
  listSourceId,
  playlistEmptyKind,
  playlistSourceId,
  playlistViewKey,
  sourceIdForReports,
  toPlaylistViewInput,
  type PlaylistSelection,
} from '../playlist-view';
import { listSortDirectionLabel, listSortKeyLabel, playlistSortModel } from '../playlist-sort-model';

function selection(overrides: Partial<PlaylistSelection> = {}): PlaylistSelection {
  return {
    filters: PLAYLIST_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: { sortBy: 'position', sortOrder: 'asc' },
    boardFit: false,
    ...overrides,
  };
}

describe('toPlaylistViewInput', () => {
  it('sends no view for the playlist order with no filter', () => {
    const view = toPlaylistViewInput(selection());
    expect(view).toBeUndefined();
    expect(playlistViewKey(view)).toBeNull();
    expect(playlistSourceId('p-1', playlistViewKey(view))).toBe('playlist:p-1');
  });

  it('carries the sort, and the seed only for Random', () => {
    expect(toPlaylistViewInput(selection({ sort: { sortBy: 'difficulty', sortOrder: 'desc' } }))).toEqual({
      sortBy: 'difficulty',
      sortOrder: 'desc',
    });
    expect(toPlaylistViewInput(selection({ sort: { sortBy: 'random', sortOrder: 'asc', sortSeed: '42' } }))).toEqual({
      sortBy: 'random',
      sortOrder: 'asc',
      sortSeed: '42',
    });
  });

  it('carries the name, "fits my board" and a board filter', () => {
    const view = toPlaylistViewInput(
      selection({ name: ' crimp ', boardFit: true, boardFilters: { onlyBenchmarks: true } }),
    );
    expect(view).toMatchObject({ name: 'crimp', onlyActiveBoard: true, onlyBenchmarks: true, sortBy: 'position' });
  });

  it('never reads the inert sort fields in the filters', () => {
    expect(
      toPlaylistViewInput(selection({ filters: { ...PLAYLIST_FILTER_DEFAULTS, sortBy: 'popular', sortOrder: 'asc' } })),
    ).toBeUndefined();
  });

  it('puts the view key in the activation source id, and keeps it out of error reports', () => {
    const view = toPlaylistViewInput(selection({ sort: { sortBy: 'name', sortOrder: 'asc' }, name: 'crimp' }));
    const sourceId = playlistSourceId('p-1', playlistViewKey(view));
    expect(sourceId).toBe('playlist:p-1|{"sortBy":"name","sortOrder":"asc","name":"crimp"}');
    expect(sourceIdForReports(sourceId)).toBe('playlist:p-1');
    expect(sourceIdForReports('smart:projects:u-1')).toBe('smart:projects:u-1');
  });
});

describe('playlistEmptyKind', () => {
  it('names a lone name search', () => {
    expect(playlistEmptyKind(selection({ name: 'crimp' }))).toBe('noName');
  });

  it('names a lone "fits my board"', () => {
    expect(playlistEmptyKind(selection({ boardFit: true }))).toBe('noBoardFit');
  });

  it('cheers a lone Unsent', () => {
    expect(playlistEmptyKind(selection({ filters: { ...PLAYLIST_FILTER_DEFAULTS, hideCompleted: true } }))).toBe(
      'allSent',
    );
  });

  it('falls back to a plain no-match for anything else, a sort never counting', () => {
    expect(playlistEmptyKind(selection({ name: 'crimp', boardFit: true }))).toBe('noMatch');
    expect(
      playlistEmptyKind(selection({ filters: { ...PLAYLIST_FILTER_DEFAULTS, hideCompleted: true, minRating: 3 } })),
    ).toBe('noMatch');
    expect(playlistEmptyKind(selection({ name: 'crimp', sort: { sortBy: 'difficulty', sortOrder: 'asc' } }))).toBe(
      'noName',
    );
  });
});

describe('playlistSortModel', () => {
  const echoT = ((key: string) => key) as unknown as TFunction<'climbs'>;

  it('offers a direction for every key but the playlist order and Random', () => {
    const withDirection = playlistSortModel.options.filter((sortBy) => playlistSortModel.hasDirection(sortBy));
    expect(withDirection).toEqual(['added', 'difficulty', 'quality', 'ascents', 'name']);
    expect(playlistSortModel.isShuffle('random')).toBe(true);
    expect(playlistSortModel.isOption('position')).toBe(true);
    expect(playlistSortModel.isOption('popular')).toBe(false);
  });

  it('words each direction for what it means', () => {
    expect(listSortDirectionLabel('difficulty', 'asc', echoT)).toBe('mobile.filter.sortDirection.difficulty.asc');
    expect(listSortDirectionLabel('added', 'desc', echoT)).toBe('mobile.filter.sortDirection.added.desc');
    expect(listSortDirectionLabel('creation', 'desc', echoT)).toBe('mobile.filter.sortDirection.creation.desc');
    expect(listSortDirectionLabel('random', 'asc', echoT)).toBe('mobile.filter.sort.random');
    expect(listSortKeyLabel('position', echoT)).toBe('mobile.filter.sort.position');
  });

  it('opens each key on its own direction, and gives Random alone a fresh seed', () => {
    expect(playlistSortModel.patchFor('position')).toEqual({ sortBy: 'position', sortOrder: 'asc' });
    expect(playlistSortModel.patchFor('difficulty')).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    expect(playlistSortModel.patchFor('added')).toEqual({ sortBy: 'added', sortOrder: 'desc' });
    expect(playlistSortModel.patchFor('quality')).toEqual({ sortBy: 'quality', sortOrder: 'desc' });
    expect(playlistSortModel.patchFor('name')).toEqual({ sortBy: 'name', sortOrder: 'asc' });
    expect(playlistSortModel.patchFor('random').sortSeed).toMatch(/^\d+$/);
    expect(playlistSortModel.patchFor('ascents')).not.toHaveProperty('sortSeed');
  });
});

describe('list source ids and sort-blind filter rules', () => {
  it('adds the view key to any list base, and reports name the base alone', () => {
    expect(listSourceId('smart:LIKED_CLIMBS:u-1', null)).toBe('smart:LIKED_CLIMBS:u-1');
    const sorted = listSourceId('smart:LIKED_CLIMBS:u-1', '{"sortBy":"name"}');
    expect(sorted).toBe('smart:LIKED_CLIMBS:u-1|{"sortBy":"name"}');
    expect(sourceIdForReports(sorted)).toBe('smart:LIKED_CLIMBS:u-1');
  });

  it('counts filters, a name and "fits my board", never the sort, whatever the list sorts by', () => {
    const setterSort = { sortBy: 'creation', sortOrder: 'asc' } as const;
    expect(hasActiveSessionFilters({ ...selection(), sort: setterSort }, PLAYLIST_FILTER_DEFAULTS)).toBe(false);
    expect(hasActiveSessionFilters(selection({ name: ' crimp ' }), PLAYLIST_FILTER_DEFAULTS)).toBe(true);
    expect(hasActiveSessionFilters(selection({ boardFit: true }), PLAYLIST_FILTER_DEFAULTS)).toBe(true);
    expect(
      hasActiveSessionFilters(
        selection({ filters: { ...PLAYLIST_FILTER_DEFAULTS, minRating: 3 } }),
        PLAYLIST_FILTER_DEFAULTS,
      ),
    ).toBe(true);
    expect(
      hasActiveSessionFilters(
        selection({ boardFilters: { holdsFilter: { '1': { HAND: 'include' } } } }),
        PLAYLIST_FILTER_DEFAULTS,
      ),
    ).toBe(true);
  });

  it('words the empty state the same for a list with sorts of its own', () => {
    expect(
      playlistEmptyKind({ ...selection({ name: 'crimp' }), sort: { sortBy: 'creation', sortOrder: 'desc' } }),
    ).toBe('noName');
  });
});
