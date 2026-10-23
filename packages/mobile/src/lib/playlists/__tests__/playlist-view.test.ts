import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  PLAYLIST_FILTER_DEFAULTS,
  playlistEmptyKind,
  playlistSourceId,
  playlistViewKey,
  sourceIdForReports,
  toPlaylistViewInput,
  type PlaylistSelection,
} from '../playlist-view';
import { playlistSortDirectionLabel, playlistSortKeyLabel, playlistSortModel } from '../playlist-sort-model';

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
    expect(playlistSortDirectionLabel('difficulty', 'asc', echoT)).toBe('mobile.filter.sortDirection.difficulty.asc');
    expect(playlistSortDirectionLabel('added', 'desc', echoT)).toBe('mobile.filter.sortDirection.added.desc');
    expect(playlistSortDirectionLabel('random', 'asc', echoT)).toBe('mobile.filter.sort.random');
    expect(playlistSortKeyLabel('position', echoT)).toBe('mobile.filter.sort.position');
  });
});
