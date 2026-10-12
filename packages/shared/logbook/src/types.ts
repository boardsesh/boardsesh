/**
 * Shared logbook search state. The logbook lets a climber search/sort their own
 * logged ascents; web and mobile drive the same backend `userAscentsFeed` query,
 * so the filter + sort shapes and the query-input builder live here and evolve
 * together. The board scope (`boardType` / `layoutIds`) is plain data here; the
 * board OPTIONS a climber can pick from come from each app's own metadata.
 */

/**
 * Server-expanded sort presets. `hardest` = effective grade desc, `easiest` its
 * mirror (asc); `recent` = newest ascent first. Older app builds only know
 * recent + hardest, and their sanitizer falls an `easiest` back to `recent`.
 */
export type LogbookSortPreset = 'recent' | 'hardest' | 'easiest';

/** Fields a custom (non-preset) logbook sort can order by. */
export type LogbookSortField = 'climbName' | 'loggedGrade' | 'consensusGrade' | 'date' | 'attemptCount';

export type LogbookSortDirection = 'asc' | 'desc';

/** How the ascent-status filter collapses to the backend `statusMode`. */
export type LogbookStatusMode = 'both' | 'send' | 'attempt';

/**
 * The one 4-way status control (All · Sends · Flashes · Attempts). Derived from
 * the stored `includeSends` / `includeAttempts` / `flashOnly` triple, which keeps
 * its shape; see `statusSegmentFor` / `filtersForStatusSegment`.
 */
export type LogbookStatusSegment = 'all' | 'sends' | 'flashes' | 'attempts';

/**
 * Which dates the logbook shows. The presets are ROLLING: they resolve against
 * "now" every time the feed input is built, so "This month" still means this
 * month next month. Only `custom` reads `fromDate` / `toDate`; every other
 * window ignores them (they are kept so switching back to Custom restores them).
 */
export type LogbookDateWindow = 'any' | 'last7' | 'month' | 'last3months' | 'year' | 'custom';

/** The "Sort by" choices (Date · Grade · Your grade · Name · Attempts). */
export type LogbookSortKey = 'date' | 'grade' | 'loggedGrade' | 'climbName' | 'attemptCount';

export type LogbookFilterState = {
  includeSends: boolean;
  includeAttempts: boolean;
  flashOnly: boolean;
  /** Difficulty id, or '' when unset. */
  minGrade: number | '';
  /** Difficulty id, or '' when unset. */
  maxGrade: number | '';
  /** Which dates to show; only `custom` reads fromDate/toDate. */
  dateWindow: LogbookDateWindow;
  /** ISO date (YYYY-MM-DD), or '' when unset. Read only by the `custom` window. */
  fromDate: string;
  /** ISO date (YYYY-MM-DD), or '' when unset. Read only by the `custom` window. */
  toDate: string;
  angleRange: [number, number];
  benchmarkOnly: boolean;
  /** Board type to scope to (e.g. 'kilter'), or '' for every board. */
  boardType: string;
  /** Layouts within `boardType`; [] = every layout. Ignored without a boardType. */
  layoutIds: number[];
  /** Minimum stars (1-5) the climber gave the ascent, or '' for any. */
  minQuality: number | '';
  /** Exact setter usernames to scope to; [] = any setter. */
  setterUsernames: string[];
};

export type LogbookSortState = {
  mode: 'preset' | 'custom';
  preset: LogbookSortPreset;
  primaryField: LogbookSortField;
  primaryDirection: LogbookSortDirection;
  secondaryField: '' | LogbookSortField;
  secondaryDirection: LogbookSortDirection;
};
