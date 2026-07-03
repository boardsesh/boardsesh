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
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_ANGLE_RANGE,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'logbookSearchPrefs';
// Persisted-schema version.
//   v2 = the sends-only status default.
//   v3 = the sends+attempts default (a climber's projects show next to sends).
// A v1/unstamped payload still on the pre-v2 "both" default gets attempts dropped
// (the v2 step); a v2 payload that still deep-equals the v2 sends-only defaults —
// i.e. the user never diverged — is refreshed to the new v3 defaults (the v3
// step). A payload the user changed is left as-is. Both steps stamp the version.
const LOGBOOK_PREFS_VERSION = 3;

// The v2 resting filter (sends-only) — the value a v2 install persisted when the
// user never touched a filter. Frozen here so the v3 "did the user diverge?"
// check compares against the historical default, not today's default (which is
// now sends+attempts). Update only if the pre-v3 filter shape itself changes.
const V2_DEFAULT_LOGBOOK_FILTERS: LogbookFilterState = {
  includeSends: true,
  includeAttempts: false,
  flashOnly: false,
  minGrade: '',
  maxGrade: '',
  fromDate: '',
  toDate: '',
  angleRange: DEFAULT_LOGBOOK_ANGLE_RANGE,
  benchmarkOnly: false,
};

/** True when a filter state matches the frozen v2 sends-only default exactly. */
function equalsV2Defaults(filters: LogbookFilterState): boolean {
  return (
    filters.includeSends === V2_DEFAULT_LOGBOOK_FILTERS.includeSends &&
    filters.includeAttempts === V2_DEFAULT_LOGBOOK_FILTERS.includeAttempts &&
    filters.flashOnly === V2_DEFAULT_LOGBOOK_FILTERS.flashOnly &&
    filters.minGrade === V2_DEFAULT_LOGBOOK_FILTERS.minGrade &&
    filters.maxGrade === V2_DEFAULT_LOGBOOK_FILTERS.maxGrade &&
    filters.fromDate === V2_DEFAULT_LOGBOOK_FILTERS.fromDate &&
    filters.toDate === V2_DEFAULT_LOGBOOK_FILTERS.toDate &&
    filters.benchmarkOnly === V2_DEFAULT_LOGBOOK_FILTERS.benchmarkOnly &&
    filters.angleRange[0] === V2_DEFAULT_LOGBOOK_FILTERS.angleRange[0] &&
    filters.angleRange[1] === V2_DEFAULT_LOGBOOK_FILTERS.angleRange[1]
  );
}

export type StoredLogbookPrefs = { filters: LogbookFilterState; sort: LogbookSortState };

/** Load persisted logbook filter/sort prefs (sanitized); null when never set. */
export async function loadLogbookPrefs(): Promise<StoredLogbookPrefs | null> {
  try {
    const stored = await getPreference<{ version?: number; filters?: unknown; sort?: unknown }>(STORAGE_KEY);
    if (!stored) return null;
    // Sanitize every field so a stale/partial payload (older app version, manual
    // edit) can never feed an invalid filter/sort into the query.
    const filters = sanitizeLogbookFilters(stored.filters);
    const sort = sanitizeLogbookSort(stored.sort);
    const storedVersion = stored.version;
    const needsMigration = storedVersion !== LOGBOOK_PREFS_VERSION;
    // v1→v2: a pre-v2 payload still on the old "both" default dropped attempts to
    // land on the sends-only default. That step only ran for unstamped/v1 data.
    if (storedVersion == null || storedVersion < 2) {
      if (filters.includeSends && filters.includeAttempts) {
        filters.includeAttempts = false;
      }
    }
    // v2→v3: attempts are now shown by default. A v2 payload that still deep-equals
    // the v2 sends-only default means the user never diverged — refresh it to the
    // new sends+attempts default. A payload the user actually changed is left
    // untouched (their "sends only" or any other custom choice round-trips).
    if (storedVersion === 2 && equalsV2Defaults(filters)) {
      filters.includeAttempts = DEFAULT_LOGBOOK_FILTERS.includeAttempts;
    }
    // Stamp the current version now rather than waiting for the next filter change,
    // so the migration check doesn't re-run on every cold launch for users who
    // never touch a filter. Fire-and-forget: a failed write just re-runs the
    // (identical) migration next launch, which is harmless.
    if (needsMigration) {
      void saveLogbookPrefs({ filters, sort });
    }
    return { filters, sort };
  } catch {
    // Storage unavailable/errored — treat as "no prefs" so the caller's
    // hydration still completes and the logbook never gets stuck loading.
    return null;
  }
}

/** Persist the logbook filter/sort prefs so they survive an app restart. */
export async function saveLogbookPrefs(prefs: StoredLogbookPrefs): Promise<void> {
  try {
    await setPreference(STORAGE_KEY, { version: LOGBOOK_PREFS_VERSION, ...prefs });
  } catch {
    // Storage write failed (full disk, first-install permission race). Persisting
    // a UI preference is best-effort, so swallow rather than leak an unhandled
    // rejection from the fire-and-forget caller (mirrors loadLogbookPrefs).
  }
}
