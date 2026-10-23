// Remembers the sort a climber picked inside each playlist, so "Hardest first"
// is still on when they come back. Filters are not remembered: they start empty
// on every visit.
//
// Kept in the MMKV settings store under `playlistSortsV1`: a synchronous read,
// so the screen's first request already carries the remembered sort (no second
// fetch once it loads). Read with `getSetting` once per mount, never through
// `useSetting`: every settings write would re-render the reader.

import { newSortSeed, SORT_ORDERS, type SortOrder } from '@boardsesh/climb-filters';
import { getSetting, setSetting } from '../../settings';
import type { StoredListSort } from '../../settings/types';
import type { SessionSort, SessionSortModel } from '../climb-filter-session-reducer';

/** How many lists keep a remembered sort. The oldest entry drops off first. */
export const MAX_REMEMBERED_LIST_SORTS = 100;

/** The memory key for one playlist. */
export function playlistSortMemoryKey(playlistUuid: string): string {
  return `playlist:${playlistUuid}`;
}

function isStoredListSort(value: unknown): value is StoredListSort {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.listKey === 'string' && typeof entry.sortBy === 'string' && typeof entry.sortOrder === 'string';
}

function isSortOrder(value: string): value is SortOrder {
  return (SORT_ORDERS as readonly string[]).includes(value);
}

/** The stored entries that still have the right shape, newest first. Anything else is dropped. */
function readEntries(): StoredListSort[] {
  const stored: unknown = getSetting('playlistSortsV1');
  if (typeof stored !== 'object' || stored === null) return [];
  const entries = (stored as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries.filter(isStoredListSort) : [];
}

function isDefaultSort<K extends string>(sort: SessionSort<K>, model: SessionSortModel<K>): boolean {
  return sort.sortBy === model.defaultSort.sortBy && sort.sortOrder === model.defaultSort.sortOrder;
}

/** A fresh copy of the model's default sort, so a caller can never mutate the shared one. */
function defaultSortOf<K extends string>(model: SessionSortModel<K>): SessionSort<K> {
  return model.patchFor(model.defaultSort.sortBy);
}

/**
 * The sort remembered for `listKey`, or the model's default. A key or direction
 * the model no longer offers falls back (a single-direction key always opens on
 * its own direction). Random comes back with a new seed: a new shuffle per visit.
 */
export function readListSort<K extends string>(listKey: string, model: SessionSortModel<K>): SessionSort<K> {
  const entry = readEntries().find((candidate) => candidate.listKey === listKey);
  if (!entry || !model.isOption(entry.sortBy)) return defaultSortOf(model);
  const sortBy = entry.sortBy;
  const sortOrder =
    model.hasDirection(sortBy) && isSortOrder(entry.sortOrder) ? entry.sortOrder : model.defaultOrder(sortBy);
  const sort: SessionSort<K> = { sortBy, sortOrder };
  if (model.isShuffle(sortBy)) sort.sortSeed = newSortSeed();
  return sort;
}

/**
 * Remembers `sort` for `listKey` as the newest entry. The default sort removes
 * the entry instead, so a list on its own order takes no room. Random is stored
 * without its seed. Writes `null` once nothing is left.
 */
export function writeListSort<K extends string>(
  listKey: string,
  sort: SessionSort<K>,
  model: SessionSortModel<K>,
): void {
  const others = readEntries().filter((entry) => entry.listKey !== listKey);
  const entries = isDefaultSort(sort, model)
    ? others
    : [{ listKey, sortBy: sort.sortBy, sortOrder: sort.sortOrder }, ...others];
  setSetting('playlistSortsV1', entries.length > 0 ? { entries: entries.slice(0, MAX_REMEMBERED_LIST_SORTS) } : null);
}
