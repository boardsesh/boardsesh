import type { LogbookFilterState, LogbookSortState } from './types';

/** Full board-angle span; angle filters at these bounds are treated as "unset". */
export const DEFAULT_LOGBOOK_ANGLE_RANGE: [number, number] = [0, 70];

export const DEFAULT_LOGBOOK_FILTERS: LogbookFilterState = {
  includeSends: true,
  includeAttempts: true,
  flashOnly: false,
  minGrade: '',
  maxGrade: '',
  fromDate: '',
  toDate: '',
  angleRange: DEFAULT_LOGBOOK_ANGLE_RANGE,
  benchmarkOnly: false,
};

/** Default sort = the "Latest" preset (most recent ascent first). */
export const DEFAULT_LOGBOOK_SORT: LogbookSortState = {
  mode: 'preset',
  preset: 'recent',
  primaryField: 'date',
  primaryDirection: 'desc',
  secondaryField: '',
  secondaryDirection: 'desc',
};
