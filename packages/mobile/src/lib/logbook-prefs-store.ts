// Persists the Logbook tab's filter + sort settings across app restarts. Backed
// by AsyncStorage (a UI preference, not a secret — see preference-store). The
// climb-name search term is intentionally NOT persisted; it's transient.
//
// Web's analogue persists the same filter/sort shape via IndexedDB
// (user-preferences-db `logbookPreferences`); both go through @boardsesh/logbook
// for the schema + sanitizers so a payload from either platform round-trips.

import {
  sanitizeLogbookFilters,
  sanitizeLogbookSort,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'logbookSearchPrefs';

export type StoredLogbookPrefs = { filters: LogbookFilterState; sort: LogbookSortState };

/** Load persisted logbook filter/sort prefs (sanitized); null when never set. */
export async function loadLogbookPrefs(): Promise<StoredLogbookPrefs | null> {
  try {
    const stored = await getPreference<{ filters?: unknown; sort?: unknown }>(STORAGE_KEY);
    if (!stored) return null;
    // Sanitize every field so a stale/partial payload (older app version, manual
    // edit) can never feed an invalid filter/sort into the query.
    return { filters: sanitizeLogbookFilters(stored.filters), sort: sanitizeLogbookSort(stored.sort) };
  } catch {
    // Storage unavailable/errored — treat as "no prefs" so the caller's
    // hydration still completes and the logbook never gets stuck loading.
    return null;
  }
}

/** Persist the logbook filter/sort prefs so they survive an app restart. */
export async function saveLogbookPrefs(prefs: StoredLogbookPrefs): Promise<void> {
  await setPreference(STORAGE_KEY, prefs);
}
