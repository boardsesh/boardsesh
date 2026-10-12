import type { GetUserAscentsFeedQueryVariables } from '@boardsesh/graphql/operations/ticks';
import { isRollingLogbookDateWindow, parseLocalIsoDate, resolveLogbookDateRange } from './date-window';
import { DEFAULT_LOGBOOK_ANGLE_RANGE } from './defaults';
import { repairLogbookStatus } from './status-segments';
import type { LogbookFilterState, LogbookSortState, LogbookStatusMode } from './types';

/** The `input` object for the userAscentsFeed query, minus pagination. */
export type AscentFeedInput = NonNullable<GetUserAscentsFeedQueryVariables['input']>;
type AscentFeedSortInput = Pick<AscentFeedInput, 'sortBy' | 'sortOrder' | 'secondarySortBy' | 'secondarySortOrder'>;

export type LogbookFeedInputArgs = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** Logbook-scoped climb-name search; trimmed, omitted when blank. */
  name?: string;
  /**
   * Explicit board scope (screenshot mode). One -> boardType, many ->
   * boardTypes. When this or `layoutIds` is non-empty it replaces the filter
   * state's own board + layouts entirely.
   */
  boardTypes?: string[];
  layoutIds?: number[];
  /** The clock rolling date windows resolve against. Defaults to `new Date()`. */
  now?: Date;
};

type BoardScope = Pick<AscentFeedInput, 'boardType' | 'boardTypes' | 'layoutIds'>;

function boardScopeInput(
  filters: LogbookFilterState,
  boardTypes: string[] | undefined,
  layoutIds: number[] | undefined,
): BoardScope {
  const hasExplicitScope = Boolean(boardTypes?.length || layoutIds?.length);
  if (hasExplicitScope) {
    return {
      ...(boardTypes && boardTypes.length === 1 ? { boardType: boardTypes[0] } : {}),
      ...(boardTypes && boardTypes.length > 1 ? { boardTypes } : {}),
      ...(layoutIds && layoutIds.length > 0 ? { layoutIds } : {}),
    };
  }
  if (!filters.boardType) return {};
  return {
    boardType: filters.boardType,
    ...(filters.layoutIds.length > 0 ? { layoutIds: filters.layoutIds } : {}),
  };
}

type DateInput = Pick<AscentFeedInput, 'fromDate' | 'toDate'>;

/**
 * The date bounds as INSTANTS (ISO timestamps), cut on the device's calendar:
 * `fromDate` is the inclusive start of the first local day, `toDate` the
 * exclusive start of the local day after the last. A bare `YYYY-MM-DD` would be
 * read as a UTC day by the backend, so a climber away from UTC would lose (or
 * gain) the hours between their midnight and UTC's. The stored state keeps
 * local `YYYY-MM-DD` strings; only the wire format is an instant.
 */
function dateInput(filters: LogbookFilterState, now: Date): DateInput {
  const { fromDate, toDate } = resolveLogbookDateRange(filters, now);
  const fromInstant = fromDate ? parseLocalIsoDate(fromDate) : null;
  // A rolling window ends today, so it sends no upper bound: nothing is logged
  // in the future.
  const toInstant = toDate && !isRollingLogbookDateWindow(filters.dateWindow) ? parseLocalIsoDate(toDate, 1) : null;
  return {
    ...(fromInstant ? { fromDate: fromInstant.toISOString() } : {}),
    ...(toInstant ? { toDate: toInstant.toISOString() } : {}),
  };
}

function statusModeFor(status: Pick<LogbookFilterState, 'includeSends' | 'includeAttempts'>): LogbookStatusMode {
  if (status.includeSends && status.includeAttempts) return 'both';
  if (status.includeSends) return 'send';
  return 'attempt';
}

function sortInput(sort: LogbookSortState): AscentFeedSortInput {
  if (sort.mode === 'preset') {
    // The resolver expands the presets: 'hardest' = effective grade (logged,
    // else consensus) desc, 'easiest' the same asc, both then newest first;
    // 'recent' = most-recent ascent first.
    if (sort.preset === 'hardest') return { sortBy: 'hardest', sortOrder: 'desc' };
    if (sort.preset === 'easiest') return { sortBy: 'easiest', sortOrder: 'asc' };
    return { sortBy: 'recent', sortOrder: 'desc' };
  }
  return {
    sortBy: sort.primaryField,
    sortOrder: sort.primaryDirection,
    ...(sort.secondaryField
      ? { secondarySortBy: sort.secondaryField, secondarySortOrder: sort.secondaryDirection }
      : {}),
  };
}

/**
 * Build the userAscentsFeed `input` from logbook filter + sort state. The data
 * hook adds `limit`/`offset`. Default-valued filters are omitted so the query
 * key stays stable, and so a backend that predates a filter (stars, setters)
 * never sees it from a climber who isn't using it. Web + mobile share this.
 */
export function toAscentFeedInput(args: LogbookFeedInputArgs): AscentFeedInput {
  const { filters, sort, name, boardTypes, layoutIds, now = new Date() } = args;
  const trimmedName = name?.trim();
  const [minAngle, maxAngle] = filters.angleRange;
  // Read the status the way the sanitizer repairs it, so an unsanitized state
  // (neither half on) queries what the UI shows.
  const status = repairLogbookStatus(filters);

  return {
    ...boardScopeInput(filters, boardTypes, layoutIds),
    ...(trimmedName ? { climbName: trimmedName } : {}),
    statusMode: statusModeFor(status),
    flashOnly: status.flashOnly,
    ...(filters.minGrade !== '' ? { minDifficulty: filters.minGrade } : {}),
    ...(filters.maxGrade !== '' ? { maxDifficulty: filters.maxGrade } : {}),
    ...dateInput(filters, now),
    ...(minAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[0] ? { minAngle } : {}),
    ...(maxAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[1] ? { maxAngle } : {}),
    ...(filters.benchmarkOnly ? { benchmarkOnly: true } : {}),
    ...(filters.minQuality !== '' ? { minQuality: filters.minQuality } : {}),
    ...(filters.setterUsernames.length > 0 ? { setterUsernames: filters.setterUsernames } : {}),
    ...sortInput(sort),
  };
}
