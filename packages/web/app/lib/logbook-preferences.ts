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
  version: 1;
  boardFilter: BoardFilter;
  layoutSelections: Record<Exclude<BoardFilter, 'all'>, number[]>;
  filters: LogbookFilterState;
  sort: LogbookSortState;
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
  version: 1,
  boardFilter: 'all',
  layoutSelections: ALL_LAYOUT_SELECTIONS,
  filters: DEFAULT_LOGBOOK_FILTERS,
  sort: DEFAULT_LOGBOOK_SORT,
};

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

  const boardFilter = VALID_BOARD_FILTERS.includes(source.boardFilter ?? 'all')
    ? (source.boardFilter as BoardFilter)
    : DEFAULT_LOGBOOK_PREFERENCES.boardFilter;

  return {
    version: 1,
    boardFilter,
    layoutSelections: sanitizeLayoutSelections(source.layoutSelections),
    // Filter/sort sanitization is delegated to the shared package so web and
    // mobile coerce persisted state identically.
    filters: sanitizeLogbookFilters(source.filters),
    sort: sanitizeLogbookSort(source.sort),
  };
}
