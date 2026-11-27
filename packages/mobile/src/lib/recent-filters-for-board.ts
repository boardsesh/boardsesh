// Recent searches follow the climber to every board and angle, the way the
// search in force does (last-search-store.ts): grade, sort and the other
// filters replay anywhere, but a climb name only means something on the board
// it was typed on. Kept apart from recent-filter-store so the climbs screen's
// tests can mock the storage module without losing this rule.

import { hasActiveClimbFilters } from '@boardsesh/climb-filters';
import type { ClimbFilters } from './climb-filter-types';
import { getFilterKey } from './filter-key';
import type { RecentFilter } from './recent-filter-store';

/**
 * The recent searches as they apply on `boardKey`. A search typed on another
 * board loses its climb name and is relabelled with `labelWithoutName`; one
 * that was only a name drops out, and two that become the same search keep
 * just the newer. Returns `recents` itself when nothing changes.
 */
export function recentFiltersForBoard(
  recents: readonly RecentFilter[],
  boardKey: string,
  labelWithoutName: (filters: ClimbFilters) => string,
): readonly RecentFilter[] {
  const fromOtherBoard = (entry: RecentFilter) =>
    entry.boardKey !== undefined && entry.boardKey !== boardKey && (entry.searchText ?? '').trim() !== '';
  if (!recents.some(fromOtherBoard)) return recents;
  const seen = new Set<string>();
  const result: RecentFilter[] = [];
  for (const entry of recents) {
    const applied = fromOtherBoard(entry)
      ? { ...entry, searchText: '', label: labelWithoutName(entry.filters) }
      : entry;
    if ((applied.searchText ?? '').trim() === '' && !hasActiveClimbFilters(applied.filters)) continue;
    const key = getFilterKey(applied.filters, applied.searchText);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(applied);
  }
  return result;
}
