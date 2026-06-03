import * as SecureStore from 'expo-secure-store';
import {
  SORT_OPTIONS,
  STATUS_FILTER_VALUES,
  normalizeRetiredStatus,
  type SortOption,
  type StatusFilter,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from './climb-filter-types';
import { getFilterKey } from './filter-key';

export { getFilterKey };

export type RecentFilter = {
  id: string;
  label: string;
  filters: ClimbFilters;
  searchText: string;
  timestamp: number;
};

const RECENT_FILTERS_KEY = 'boardsesh_recent_filters';
const MAX_ITEMS = 10;

// Fields the backend only honours for authenticated users. When loading
// pills while signed out we strip these so a recent search from a previous
// signed-in session doesn't silently no-op (UI would show the pill as
// "active" but the list would be unfiltered).
export const AUTH_GATED_FIELDS = [
  'hideAttempted',
  'hideCompleted',
  'showOnlyAttempted',
  'showOnlyCompleted',
] as const satisfies ReadonlyArray<keyof ClimbFilters>;

function isValidEntry(entry: unknown): entry is RecentFilter {
  if (entry == null || typeof entry !== 'object') return false;
  const candidate = entry as { filters?: { sortBy?: unknown; status?: unknown }; id?: unknown; label?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') return false;
  const filters = candidate.filters;
  if (filters == null) return false;
  if (typeof filters.sortBy !== 'string' || !(SORT_OPTIONS as readonly string[]).includes(filters.sortBy)) return false;
  // If status is present but unknown, drop. Missing status is normalized
  // later (older app versions wrote entries before the field existed); see
  // normalizeEntry.
  if (filters.status != null && !(STATUS_FILTER_VALUES as readonly string[]).includes(filters.status as string)) {
    return false;
  }
  return true;
}

// Backfill defaults that were added after old entries were written. Without
// this, an entry missing `status` would render as "active" since
// `hasActiveClimbFilters` treats `undefined !== 'any'` as a change.
function normalizeEntry(entry: RecentFilter): RecentFilter {
  const status = entry.filters.status ?? 'any';
  // Backfill a missing status and retire legacy 'established' → 'any' (the
  // Popularity control reflects minAscents), so replayed pills never carry a
  // status the UI can't show.
  return { ...entry, filters: normalizeRetiredStatus({ ...entry.filters, status }) };
}

function stripAuthGatedFields(filters: ClimbFilters): ClimbFilters {
  const sanitized = { ...filters };
  for (const field of AUTH_GATED_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

/**
 * Read recent filter pills from secure storage. Drops entries written by
 * older app versions that carry an unknown `sortBy` or `status`. Pass
 * `isAuthenticated = false` to also strip auth-gated filters from each
 * entry — used by the climbs tab so signed-out users don't tap pills that
 * silently no-op on the backend.
 */
export async function getRecentFilters(options?: { isAuthenticated?: boolean }): Promise<RecentFilter[]> {
  try {
    const value = await SecureStore.getItemAsync(RECENT_FILTERS_KEY);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidEntry).map(normalizeEntry);
    if (options?.isAuthenticated === false) {
      return valid.map((entry) => ({ ...entry, filters: stripAuthGatedFields(entry.filters) }));
    }
    return valid;
  } catch {
    return [];
  }
}

export async function addRecentFilter(label: string, filters: ClimbFilters, searchText: string): Promise<void> {
  try {
    const existing = await getRecentFilters();
    const filterKey = getFilterKey(filters, searchText);

    const deduplicated = existing.filter((entry) => getFilterKey(entry.filters, entry.searchText) !== filterKey);

    const newEntry: RecentFilter = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label,
      filters,
      searchText,
      timestamp: Date.now(),
    };

    const updated = [newEntry, ...deduplicated].slice(0, MAX_ITEMS);
    await SecureStore.setItemAsync(RECENT_FILTERS_KEY, JSON.stringify(updated));
  } catch {
    // Storage failure is non-critical
  }
}

export async function clearRecentFilters(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(RECENT_FILTERS_KEY);
  } catch {
    // Storage failure is non-critical
  }
}

// Re-exported for test setup convenience.
export const _AUTH_GATED_FIELDS_FOR_TESTS = AUTH_GATED_FIELDS;
