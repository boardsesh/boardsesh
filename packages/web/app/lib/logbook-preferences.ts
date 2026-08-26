import { getAllLayouts } from '@/app/lib/board-constants';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import {
  DEFAULT_LOGBOOK_ANGLE_RANGE,
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  sanitizeLogbookFilters,
  sanitizeLogbookSort,
  type LogbookFilterState,
  type LogbookSortDirection,
  type LogbookSortField,
  type LogbookSortPreset,
  type LogbookSortState,
} from '@boardsesh/logbook';

// Re-export the shared filter/sort types and defaults under the web names so
// existing web importers keep working. The filter/sort/preset logic now lives
// in @boardsesh/logbook and is shared with mobile; only the board/layout
// pieces below (which depend on web board metadata) stay web-specific.
export type { LogbookFilterState, LogbookSortState };
export type SortPreset = LogbookSortPreset;
export type SortField = LogbookSortField;
export type SortDirection = LogbookSortDirection;

export {
  DEFAULT_LOGBOOK_ANGLE_RANGE as DEFAULT_ANGLE_RANGE,
  DEFAULT_LOGBOOK_FILTERS as DEFAULT_FILTERS,
  DEFAULT_LOGBOOK_SORT as DEFAULT_SORT,
};

export type BoardFilter = 'all' | 'moonboard' | AuroraBoardName;

export type LogbookPreferences = {
  version: 4;
  boardFilter: BoardFilter;
  layoutSelections: Record<Exclude<BoardFilter, 'all'>, number[]>;
  filters: LogbookFilterState;
  sort: LogbookSortState;
};

// The v2 resting filter (sends-only). Frozen so the v3 "did the user diverge?"
// check compares against the historical v2 default, not today's default (now
// sends+attempts). Only the status pair distinguishes it from the v3 default,
// so that pair is what the check reads.
// Frozen LITERALLY (not spread from the live defaults): the never-diverged
// check must compare against what v2 actually persisted, and a future change
// to any live default would silently redefine history through a spread.
const V2_DEFAULT_FILTERS: LogbookFilterState = {
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
function filtersEqualV1Defaults(filters: LogbookFilterState): boolean {
  return filters.includeAttempts === true && filtersEqualV2Defaults({ ...filters, includeAttempts: false });
}

export const ALL_LAYOUT_SELECTIONS: Record<Exclude<BoardFilter, 'all'>, number[]> = {
  kilter: getAllLayouts('kilter').map((layout) => layout.id),
  tension: getAllLayouts('tension').map((layout) => layout.id),
  moonboard: getAllLayouts('moonboard').map((layout) => layout.id),
  decoy: getAllLayouts('decoy').map((layout) => layout.id),
  touchstone: getAllLayouts('touchstone').map((layout) => layout.id),
  grasshopper: getAllLayouts('grasshopper').map((layout) => layout.id),
  soill: getAllLayouts('soill').map((layout) => layout.id),
};

export const DEFAULT_LOGBOOK_PREFERENCES: LogbookPreferences = {
  version: 4,
  boardFilter: 'all',
  layoutSelections: ALL_LAYOUT_SELECTIONS,
  filters: DEFAULT_LOGBOOK_FILTERS,
  sort: DEFAULT_LOGBOOK_SORT,
};

/** True when a filter state matches the frozen v2 sends-only default exactly. */
function filtersEqualV2Defaults(filters: LogbookFilterState): boolean {
  return (
    filters.includeSends === V2_DEFAULT_FILTERS.includeSends &&
    filters.includeAttempts === V2_DEFAULT_FILTERS.includeAttempts &&
    filters.flashOnly === V2_DEFAULT_FILTERS.flashOnly &&
    filters.minGrade === V2_DEFAULT_FILTERS.minGrade &&
    filters.maxGrade === V2_DEFAULT_FILTERS.maxGrade &&
    filters.fromDate === V2_DEFAULT_FILTERS.fromDate &&
    filters.toDate === V2_DEFAULT_FILTERS.toDate &&
    filters.benchmarkOnly === V2_DEFAULT_FILTERS.benchmarkOnly &&
    filters.angleRange[0] === V2_DEFAULT_FILTERS.angleRange[0] &&
    filters.angleRange[1] === V2_DEFAULT_FILTERS.angleRange[1]
  );
}

const VALID_BOARD_FILTERS: BoardFilter[] = ['all', 'moonboard', ...AURORA_BOARDS];

function sanitizeLayoutSelections(value: unknown): Record<Exclude<BoardFilter, 'all'>, number[]> {
  const source =
    value && typeof value === 'object' ? (value as Partial<Record<Exclude<BoardFilter, 'all'>, unknown>>) : {};

  return {
    kilter: sanitizeBoardLayouts(source.kilter, 'kilter'),
    tension: sanitizeBoardLayouts(source.tension, 'tension'),
    moonboard: sanitizeBoardLayouts(source.moonboard, 'moonboard'),
    decoy: sanitizeBoardLayouts(source.decoy, 'decoy'),
    touchstone: sanitizeBoardLayouts(source.touchstone, 'touchstone'),
    grasshopper: sanitizeBoardLayouts(source.grasshopper, 'grasshopper'),
    soill: sanitizeBoardLayouts(source.soill, 'soill'),
  };
}

function sanitizeBoardLayouts(value: unknown, board: Exclude<BoardFilter, 'all'>): number[] {
  const validIds = new Set(ALL_LAYOUT_SELECTIONS[board]);
  const ids = Array.isArray(value)
    ? value.filter((candidate): candidate is number => typeof candidate === 'number' && validIds.has(candidate))
    : [];

  return ids.length > 0 ? Array.from(new Set(ids)).sort((a, b) => a - b) : ALL_LAYOUT_SELECTIONS[board];
}

export function sanitizeLogbookPreferences(value: unknown): LogbookPreferences {
  if (!value || typeof value !== 'object') {
    return DEFAULT_LOGBOOK_PREFERENCES;
  }

  const source = value as Partial<LogbookPreferences>;
  const storedVersion = (value as { version?: number }).version;

  const boardFilter = VALID_BOARD_FILTERS.includes(source.boardFilter ?? 'all')
    ? (source.boardFilter as BoardFilter)
    : DEFAULT_LOGBOOK_PREFERENCES.boardFilter;

  // Filter/sort sanitization is delegated to the shared package so web and
  // mobile coerce persisted state identically.
  const filters = sanitizeLogbookFilters(source.filters);
  const storedFilters =
    source.filters && typeof source.filters === 'object' ? (source.filters as Partial<LogbookFilterState>) : null;
  const filtersForStatusMigration =
    (storedVersion == null || storedVersion < 3) && storedFilters?.angleRange === undefined
      ? { ...filters, angleRange: [0, 70] as [number, number] }
      : filters;

  // →v3: attempts show by default again. The obsolete v1→v2 attempts-drop is
  // gone — chaining it would strand never-touched legacy payloads on
  // sends-only, the opposite of the new default (v1's "both" resting state
  // already matches where v3 lands). One rule for every pre-v3 payload: a
  // filter set still deep-equal to EITHER historical resting default (v1
  // both-on or v2 sends-only) means the user never diverged — refresh to the
  // current defaults. Anything else was a deliberate choice and round-trips.
  // Known unrecoverable cohort: a v1 user with extra filters whom the OLD
  // v1→v2 attempts-drop already migrated is stored as a diverged v2 state;
  // their attempts-on intent was destroyed before v3 existed and can't be
  // told apart from a genuine sends-only choice, so they keep sends-only.
  if (
    (storedVersion == null || storedVersion < 3) &&
    (filtersEqualV2Defaults(filtersForStatusMigration) || filtersEqualV1Defaults(filtersForStatusMigration))
  ) {
    filters.includeAttempts = DEFAULT_LOGBOOK_FILTERS.includeAttempts;
    filters.includeSends = DEFAULT_LOGBOOK_FILTERS.includeSends;
  }

  // v4 widens the shared board-angle range for Grasshopper's real -5° data.
  // A lower bound of 0 in an older payload represented the historical default,
  // so carry it forward to -5 while preserving an intentionally narrower
  // positive lower bound. Once stamped v4, [0, 70] is an explicit user choice.
  if ((storedVersion == null || storedVersion < 4) && filters.angleRange[0] === 0) {
    filters.angleRange = [DEFAULT_LOGBOOK_ANGLE_RANGE[0], filters.angleRange[1]];
  }

  return {
    version: 4,
    boardFilter,
    layoutSelections: sanitizeLayoutSelections(source.layoutSelections),
    filters,
    sort: sanitizeLogbookSort(source.sort),
  };
}
