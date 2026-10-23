// A playlist's sorts as the filter session reads them: the keys, the default
// (the playlist's own order), each key's opening direction and its labels.
//
// The sort never enters `ClimbFilters` or the Climbs `SortOption`, so the
// playlist-only keys (`position`, `added`) cannot leak into the Climbs list.
// Labels are a switch over literal keys: the i18n orphan check cannot follow
// `t(variable)`.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  DEFAULT_PLAYLIST_VIEW_STATE,
  PLAYLIST_SORT_DEFAULT_ORDER,
  PLAYLIST_SORT_OPTIONS,
  playlistSortPatch,
  type PlaylistSortOption,
  type SortOrder,
} from '@boardsesh/climb-filters';
import type { SessionSort, SessionSortLabels, SessionSortModel } from '../climb-filter-session-reducer';

export type PlaylistSessionSort = SessionSort<PlaylistSortOption>;

export const DEFAULT_PLAYLIST_SORT: PlaylistSessionSort = {
  sortBy: DEFAULT_PLAYLIST_VIEW_STATE.sortBy,
  sortOrder: DEFAULT_PLAYLIST_VIEW_STATE.sortOrder,
};

function isPlaylistSortOption(value: string): value is PlaylistSortOption {
  return (PLAYLIST_SORT_OPTIONS as readonly string[]).includes(value);
}

/** The menu and chip name of each key. */
export function playlistSortKeyLabel(sortBy: PlaylistSortOption, t: TFunction<'climbs'>): string {
  switch (sortBy) {
    case 'position':
      return t('mobile.filter.sort.position');
    case 'added':
      return t('mobile.filter.sort.added');
    case 'difficulty':
      return t('mobile.filter.sort.difficulty');
    case 'quality':
      return t('mobile.filter.sort.quality');
    case 'ascents':
      return t('mobile.filter.sort.ascents');
    case 'name':
      return t('mobile.filter.sort.name');
    case 'random':
      return t('mobile.filter.sort.random');
  }
}

/**
 * What a direction means for each key ("Easiest first", "Newest first"), the
 * chip's label once a sort is picked. The playlist order and Random have one
 * direction, so they read as their key.
 */
export function playlistSortDirectionLabel(
  sortBy: PlaylistSortOption,
  sortOrder: SortOrder,
  t: TFunction<'climbs'>,
): string {
  const ascending = sortOrder === 'asc';
  switch (sortBy) {
    case 'difficulty':
      return ascending
        ? t('mobile.filter.sortDirection.difficulty.asc')
        : t('mobile.filter.sortDirection.difficulty.desc');
    case 'added':
      return ascending ? t('mobile.filter.sortDirection.added.asc') : t('mobile.filter.sortDirection.added.desc');
    case 'quality':
      return ascending ? t('mobile.filter.sortDirection.quality.asc') : t('mobile.filter.sortDirection.quality.desc');
    case 'ascents':
      return ascending ? t('mobile.filter.sortDirection.ascents.asc') : t('mobile.filter.sortDirection.ascents.desc');
    case 'name':
      return ascending ? t('mobile.filter.sortDirection.name.asc') : t('mobile.filter.sortDirection.name.desc');
    case 'position':
    case 'random':
      return playlistSortKeyLabel(sortBy, t);
  }
}

function usePlaylistSortLabels(): SessionSortLabels<PlaylistSortOption> {
  const { t } = useTranslation('climbs');
  return useMemo(
    () => ({
      keyLabel: (sortBy: PlaylistSortOption) => playlistSortKeyLabel(sortBy, t),
      directionLabel: (sortBy: PlaylistSortOption, sortOrder: SortOrder) =>
        playlistSortDirectionLabel(sortBy, sortOrder, t),
      resting: playlistSortKeyLabel(DEFAULT_PLAYLIST_SORT.sortBy, t),
    }),
    [t],
  );
}

export const playlistSortModel: SessionSortModel<PlaylistSortOption> = {
  options: PLAYLIST_SORT_OPTIONS,
  defaultSort: DEFAULT_PLAYLIST_SORT,
  defaultOrder: (sortBy) => PLAYLIST_SORT_DEFAULT_ORDER[sortBy],
  patchFor: playlistSortPatch,
  hasDirection: (sortBy) => sortBy !== 'position' && sortBy !== 'random',
  isShuffle: (sortBy) => sortBy === 'random',
  isOption: isPlaylistSortOption,
  useLabels: usePlaylistSortLabels,
};
