// A list's sorts as the filter session reads them: the keys, the default, each
// key's opening direction and its labels. One factory serves every list that
// has a session: a playlist, a smart list, a setter page.
//
// The sort never enters `ClimbFilters` or the Climbs `SortOption`, so a list's
// own keys (`position`, `added`) cannot leak into the Climbs list. Labels are a
// switch over literal keys: the i18n orphan check cannot follow `t(variable)`.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  DEFAULT_PLAYLIST_VIEW_STATE,
  PLAYLIST_SORT_DEFAULT_ORDER,
  PLAYLIST_SORT_OPTIONS,
  newSortSeed,
  type PlaylistSortOption,
  type SortOrder,
} from '@boardsesh/climb-filters';
import type { SessionSort, SessionSortLabels, SessionSortModel } from '../climb-filter-session-reducer';

/** Every key a list's sort can use: a playlist's, plus the Climbs list's "Newest" for setter pages. */
export type ListSortKey = PlaylistSortOption | 'creation';

export type PlaylistSessionSort = SessionSort<PlaylistSortOption>;

export const DEFAULT_PLAYLIST_SORT: PlaylistSessionSort = {
  sortBy: DEFAULT_PLAYLIST_VIEW_STATE.sortBy,
  sortOrder: DEFAULT_PLAYLIST_VIEW_STATE.sortOrder,
};

/** The menu and chip name of each key. */
export function listSortKeyLabel(sortBy: ListSortKey, t: TFunction<'climbs'>): string {
  switch (sortBy) {
    case 'position':
      return t('mobile.filter.sort.position');
    case 'added':
      return t('mobile.filter.sort.added');
    case 'creation':
      return t('mobile.filter.sort.creation');
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
 * chip's label once a sort is picked. A list's own order and Random have one
 * direction, so they read as their key.
 */
export function listSortDirectionLabel(sortBy: ListSortKey, sortOrder: SortOrder, t: TFunction<'climbs'>): string {
  const ascending = sortOrder === 'asc';
  switch (sortBy) {
    case 'difficulty':
      return ascending
        ? t('mobile.filter.sortDirection.difficulty.asc')
        : t('mobile.filter.sortDirection.difficulty.desc');
    case 'added':
      return ascending ? t('mobile.filter.sortDirection.added.asc') : t('mobile.filter.sortDirection.added.desc');
    case 'creation':
      return ascending ? t('mobile.filter.sortDirection.creation.asc') : t('mobile.filter.sortDirection.creation.desc');
    case 'quality':
      return ascending ? t('mobile.filter.sortDirection.quality.asc') : t('mobile.filter.sortDirection.quality.desc');
    case 'ascents':
      return ascending ? t('mobile.filter.sortDirection.ascents.asc') : t('mobile.filter.sortDirection.ascents.desc');
    case 'name':
      return ascending ? t('mobile.filter.sortDirection.name.asc') : t('mobile.filter.sortDirection.name.desc');
    case 'position':
    case 'random':
      return listSortKeyLabel(sortBy, t);
  }
}

export type ListSortModelConfig<K extends ListSortKey> = {
  options: readonly K[];
  defaultSort: SessionSort<K>;
  /** The direction each key opens on. */
  defaultOrder: Readonly<Record<K, SortOrder>>;
  /** The keys with one direction: a list's own order and Random. */
  singleDirection: readonly K[];
  /**
   * A list's own name for a key, or null for the shared one: a smart list calls
   * its own order "Recently liked". Return literal-key `t` calls only.
   */
  ownKeyLabel?: (sortBy: K, t: TFunction<'climbs'>) => string | null;
};

/**
 * A list's sort model. Keep the result a module constant: its `useLabels` runs
 * as a hook in the session. A tap on a key opens it on its own direction, and
 * Random gets a fresh seed, so a re-tap is a new shuffle.
 */
export function makeListSortModel<K extends ListSortKey>(config: ListSortModelConfig<K>): SessionSortModel<K> {
  const { options, defaultSort, defaultOrder, singleDirection, ownKeyLabel } = config;
  const isOption = (value: string): value is K => (options as readonly string[]).includes(value);
  const hasDirection = (sortBy: K) => !singleDirection.includes(sortBy);
  const keyLabel = (sortBy: K, t: TFunction<'climbs'>) => ownKeyLabel?.(sortBy, t) ?? listSortKeyLabel(sortBy, t);

  function useListSortLabels(): SessionSortLabels<K> {
    const { t } = useTranslation('climbs');
    return useMemo(
      () => ({
        keyLabel: (sortBy: K) => keyLabel(sortBy, t),
        directionLabel: (sortBy: K, sortOrder: SortOrder) =>
          hasDirection(sortBy) ? listSortDirectionLabel(sortBy, sortOrder, t) : keyLabel(sortBy, t),
        resting: keyLabel(defaultSort.sortBy, t),
      }),
      [t],
    );
  }

  return {
    options,
    defaultSort,
    defaultOrder: (sortBy) => defaultOrder[sortBy],
    patchFor: (sortBy) => {
      const sort: SessionSort<K> = { sortBy, sortOrder: defaultOrder[sortBy] };
      if (sortBy === 'random') sort.sortSeed = newSortSeed();
      return sort;
    },
    hasDirection,
    isShuffle: (sortBy) => sortBy === 'random',
    isOption,
    useLabels: useListSortLabels,
  };
}

/** A playlist's sorts: its own order first and by default, then the rest. */
export const playlistSortModel: SessionSortModel<PlaylistSortOption> = makeListSortModel({
  options: PLAYLIST_SORT_OPTIONS,
  defaultSort: DEFAULT_PLAYLIST_SORT,
  defaultOrder: PLAYLIST_SORT_DEFAULT_ORDER,
  singleDirection: ['position', 'random'],
});
