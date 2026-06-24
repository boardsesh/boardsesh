/**
 * Shared logbook search state. The logbook lets a climber search/sort their own
 * logged ascents; web and mobile drive the same backend `userAscentsFeed` query,
 * so the filter + sort shapes and the query-input builder live here and evolve
 * together. Board/layout selection is platform-specific (it needs each app's
 * board metadata) and is passed into `toAscentFeedInput` rather than modelled
 * here.
 */

export type LogbookSortPreset = 'recent' | 'hardest';

/** Fields a custom (non-preset) logbook sort can order by. */
export type LogbookSortField = 'climbName' | 'loggedGrade' | 'consensusGrade' | 'date' | 'attemptCount';

export type LogbookSortDirection = 'asc' | 'desc';

/** How the ascent-status filter collapses to the backend `statusMode`. */
export type LogbookStatusMode = 'both' | 'send' | 'attempt';

export type LogbookFilterState = {
  includeSends: boolean;
  includeAttempts: boolean;
  flashOnly: boolean;
  /** Difficulty id, or '' when unset. */
  minGrade: number | '';
  /** Difficulty id, or '' when unset. */
  maxGrade: number | '';
  /** ISO date (YYYY-MM-DD), or '' when unset. */
  fromDate: string;
  /** ISO date (YYYY-MM-DD), or '' when unset. */
  toDate: string;
  angleRange: [number, number];
  benchmarkOnly: boolean;
};

export type LogbookSortState = {
  mode: 'preset' | 'custom';
  preset: LogbookSortPreset;
  primaryField: LogbookSortField;
  primaryDirection: LogbookSortDirection;
  secondaryField: '' | LogbookSortField;
  secondaryDirection: LogbookSortDirection;
};
