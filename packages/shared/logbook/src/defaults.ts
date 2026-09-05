// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { LogbookFilterState, LogbookSortState } from './types';

/** Full board-angle span; angle filters at these bounds are treated as "unset". */
export const DEFAULT_LOGBOOK_ANGLE_RANGE: [number, number] = [-5, 70];

// The resting logbook filter. Status defaults to sends AND attempts: a climber's
// projects belong in the logbook next to their sends by default, and the Show
// chip rests neutral there. This default is shared by mobile AND web, so it is an
// intentional, non-flag-gated behaviour change on web too — a web logbook with no
// saved preferences, and a bookmarked URL with no status param, now shows both
// instead of sends-only. The URL canonicaliser emits an explicit status param
// only when it differs from this default, so "sends only" still round-trips.
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
