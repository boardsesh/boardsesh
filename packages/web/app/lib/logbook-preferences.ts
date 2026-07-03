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
  version: 3;
  boardFilter: BoardFilter;
  layoutSelections: Record<Exclude<BoardFilter, 'all'>, number[]>;
  filters: LogbookFilterState;
  sort: LogbookSortState;
};

// The v2 resting filter (sends-only). Frozen so the v3 "did the user diverge?"
// check compares against the historical v2 default, not today's default (now
// sends+attempts). Only the status pair distinguishes it from the v3 default,
// so that pair is what the check reads.
const V2_DEFAULT_FILTERS: LogbookFilterState = {
  ...DEFAULT_LOGBOOK_FILTERS,
  includeSends: true,
  includeAttempts: false,
};

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
  version: 3,
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

  // v1→v2: pre-v2 prefs (no stamp) that still carried the old "both" default get
  // attempts dropped to land on the sends-only default. Only for unstamped/v1 data.
  if ((storedVersion == null || storedVersion < 2) && filters.includeSends && filters.includeAttempts) {
    filters.includeAttempts = false;
  }

  // v2→v3: attempts are now shown by default. A v2 payload that still deep-equals
  // the v2 sends-only default means the user never diverged — refresh it to the
  // new sends+attempts default. Prefs the user actually changed are left as-is, so
  // an explicit "sends only" round-trips.
  if (storedVersion === 2 && filtersEqualV2Defaults(filters)) {
    filters.includeAttempts = DEFAULT_LOGBOOK_FILTERS.includeAttempts;
  }

  return {
    version: 3,
    boardFilter,
    layoutSelections: sanitizeLayoutSelections(source.layoutSelections),
    filters,
    sort: sanitizeLogbookSort(source.sort),
  };
}
