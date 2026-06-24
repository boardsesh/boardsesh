import type { GetUserAscentsFeedQueryVariables } from '@boardsesh/graphql/operations/ticks';
import { DEFAULT_LOGBOOK_ANGLE_RANGE } from './defaults';
import type { LogbookFilterState, LogbookSortState, LogbookStatusMode } from './types';

/** The `input` object for the userAscentsFeed query, minus pagination. */
export type AscentFeedInput = NonNullable<GetUserAscentsFeedQueryVariables['input']>;
type AscentFeedSortInput = Pick<AscentFeedInput, 'sortBy' | 'sortOrder' | 'secondarySortBy' | 'secondarySortOrder'>;

export type LogbookFeedInputArgs = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** Logbook-scoped climb-name search; trimmed, omitted when blank. */
  name?: string;
  /** Board types to scope to. One -> boardType, many -> boardTypes. */
  boardTypes?: string[];
  layoutIds?: number[];
};

function statusModeFor(filters: LogbookFilterState): LogbookStatusMode {
  if (filters.includeSends && filters.includeAttempts) return 'both';
  if (filters.includeSends) return 'send';
  return 'attempt';
}

function sortInput(sort: LogbookSortState): AscentFeedSortInput {
  if (sort.mode === 'preset') {
    // 'hardest' is expanded server-side to consensus desc -> effective grade
    // desc -> ascent date desc; 'recent' is most-recent ascent first.
    return sort.preset === 'hardest'
      ? { sortBy: 'hardest', sortOrder: 'desc' }
      : { sortBy: 'recent', sortOrder: 'desc' };
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
 * key stays stable. Mirrors the original web mapping so web + mobile behave
 * identically.
 */
export function toAscentFeedInput(args: LogbookFeedInputArgs): AscentFeedInput {
  const { filters, sort, name, boardTypes, layoutIds } = args;
  const trimmedName = name?.trim();
  const [minAngle, maxAngle] = filters.angleRange;

  return {
    ...(boardTypes && boardTypes.length === 1 ? { boardType: boardTypes[0] } : {}),
    ...(boardTypes && boardTypes.length > 1 ? { boardTypes } : {}),
    ...(layoutIds && layoutIds.length > 0 ? { layoutIds } : {}),
    ...(trimmedName ? { climbName: trimmedName } : {}),
    statusMode: statusModeFor(filters),
    flashOnly: filters.includeSends ? filters.flashOnly : false,
    ...(filters.minGrade !== '' ? { minDifficulty: filters.minGrade } : {}),
    ...(filters.maxGrade !== '' ? { maxDifficulty: filters.maxGrade } : {}),
    ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters.toDate ? { toDate: filters.toDate } : {}),
    ...(minAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[0] ? { minAngle } : {}),
    ...(maxAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[1] ? { maxAngle } : {}),
    ...(filters.benchmarkOnly ? { benchmarkOnly: true } : {}),
    ...sortInput(sort),
  };
}
