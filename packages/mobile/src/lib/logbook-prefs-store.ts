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
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'logbookSearchPrefs';
// Persisted-schema version.
//   v2 = the sends-only status default.
//   v3 = the sends+attempts default (a climber's projects show next to sends).
//   v4 = the full angle range starts at Grasshopper's -5° setting.
// There is no chained v1→v2 step anymore: ONE rule migrates every pre-v3
// payload. A filter set still deep-equal to EITHER historical resting default
// (v1 both-on or v2 sends-only) means the user never diverged and is refreshed
// to the v3 defaults; anything the user changed is left as-is. The migration
// stamps v3 either way.
const LOGBOOK_PREFS_VERSION = 4;

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
  // Frozen LITERAL, deliberately not DEFAULT_LOGBOOK_ANGLE_RANGE: if the live
  // constant ever changes, this historical snapshot must NOT move with it.
  angleRange: [0, 70],
  benchmarkOnly: false,
};

/**
 * True when a filter state matches the frozen v1 both-on resting default.
 * Defined by derivation, not a snapshot constant: historically the v2 default
 * changed ONLY includeAttempts, so "v1 resting" is exactly "attempts on, and
 * everything else equal to the frozen v2 shape".
 */
function equalsV1Defaults(filters: LogbookFilterState): boolean {
  return filters.includeAttempts === true && equalsV2Defaults({ ...filters, includeAttempts: false });
}

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
    const storedFilters =
      stored.filters && typeof stored.filters === 'object' ? (stored.filters as Partial<LogbookFilterState>) : null;
    const filtersForStatusMigration =
      (storedVersion == null || storedVersion < 3) && storedFilters?.angleRange === undefined
        ? { ...filters, angleRange: [0, 70] as [number, number] }
        : filters;
    // →v3: attempts show by default again. The obsolete v1→v2 attempts-drop is
    // GONE — chaining it would strand never-touched legacy payloads on
    // sends-only, the opposite of the new default (v1's "both" resting state
    // already matches where v3 lands). One rule for every pre-v3 payload:
    // a filter set still deep-equal to EITHER historical resting default
    // (v1 both-on or v2 sends-only) means the user never diverged — refresh it
    // to the current defaults. Anything else is a deliberate choice and
    // round-trips untouched.
    // Known unrecoverable cohort: a v1 user with extra filters (e.g. a grade)
    // whom the OLD v1→v2 attempts-drop already migrated is stored as a diverged
    // v2 state — sends-only plus their filters. Their attempts-on intent was
    // destroyed by that migration before v3 existed and is indistinguishable
    // from a genuine sends-only choice, so they keep sends-only here.
    if (storedVersion == null || storedVersion < 3) {
      if (equalsV2Defaults(filtersForStatusMigration) || equalsV1Defaults(filtersForStatusMigration)) {
        filters.includeAttempts = DEFAULT_LOGBOOK_FILTERS.includeAttempts;
        filters.includeSends = DEFAULT_LOGBOOK_FILTERS.includeSends;
      }
    }
    // Before v4, 0 was the default lower bound. Expand that historical default
    // to include Grasshopper -5° while preserving deliberately positive minima.
    // A v4 [0, 70] remains an explicit user choice.
    if ((storedVersion == null || storedVersion < 4) && filters.angleRange[0] === 0) {
      filters.angleRange = [DEFAULT_LOGBOOK_FILTERS.angleRange[0], filters.angleRange[1]];
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
