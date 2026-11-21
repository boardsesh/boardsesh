import { useEffect, useRef } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  countActiveFilters,
  hasActiveBoardFilters,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { hasActiveFilters, type ClimbFilters } from '../../components/ClimbFilterSheet';
import { track } from '../../lib/analytics';
import type { useGradeFormat } from '../use-grade-format';

function queryLengthBucket(query: string): 'none' | 'short' | 'medium' | 'long' {
  const queryLength = query.trim().length;
  if (queryLength === 0) return 'none';
  if (queryLength <= 8) return 'short';
  if (queryLength <= 24) return 'medium';
  return 'long';
}

type ClimbSearchAnalyticsOptions = BoardSearchConfig & {
  firstSearchPage: { climbs: Climb[] } | undefined;
  isPlaceholderData: boolean;
  showFilters: boolean;
  climbCount: number;
  name: string;
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  gradeFormat: ReturnType<typeof useGradeFormat>['gradeFormat'];
};

/** Report a settled result once; placeholder rows and open edits are not results. */
export function useClimbSearchAnalytics({
  firstSearchPage,
  isPlaceholderData,
  showFilters,
  climbCount,
  name,
  filters,
  boardFilters,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  gradeFormat,
}: ClimbSearchAnalyticsOptions) {
  // Fire "Climb Search Performed" once per resolved search/filter result set.
  // Keyed on the search text + filter signature so it fires when a new result
  // set lands — not on every keystroke (debounced upstream) or paginated page.
  const lastSearchTrackKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Placeholder rows are the PREVIOUS search's results. Tracking them would log
    // the old result count under the new filters and burn the track key, so the
    // real result for these filters would never be logged.
    if (!firstSearchPage || isPlaceholderData || showFilters) return;
    // Skip the default state (no search text, no active filters): the initial
    // tab-mount load is not a user search/apply, and web suppresses it the same
    // way (only fires when at least one filter/term is active).
    if (name.length === 0 && !hasActiveFilters(filters) && !hasActiveBoardFilters(boardFilters)) {
      // Clearing a settled search ends that interaction. Repeating the same
      // query later is a new search, even when React Query reuses its results.
      lastSearchTrackKeyRef.current = null;
      return;
    }
    const trackKey = JSON.stringify({ name, filters, boardFilters, boardName, layoutId, sizeId, setIds, angle });
    if (lastSearchTrackKeyRef.current === trackKey) return;
    lastSearchTrackKeyRef.current = trackKey;
    // Matches the `isEmpty` check driving the empty-state UI below (deduped
    // count, not the raw page-0 length) so the snapshot fires exactly when the
    // user actually sees zero rows.
    const isZeroResult = climbCount === 0;
    track(SHARED_EVENTS.ClimbSearchPerformed, {
      hasQuery: name.length > 0,
      queryLengthBucket: queryLengthBucket(name),
      // The search payload carries `climbs` + `hasMore` only — no total count
      // (that lives in the separate count query). Report the size of the
      // resolved page-0 result set, which is what's available at this point.
      resultCount: firstSearchPage.climbs.length,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      // Grade-inclusive, matching the filter button's badge — a set grade is an
      // active filter, so the analytics count and the UI never disagree (and a
      // grade-only search reports 1, not 0).
      activeFilterCount: countActiveFilters(filters, boardFilters),
      // Individual filter dimensions (issue #3290): web sends these so the two
      // platforms are comparable — "what share set a grade range / changed the
      // sort?". `0` = unset to match web's sentinel (DEFAULT_SEARCH_PARAMS all
      // default to 0; difficulty ids start at 10, so 0 is never a real grade),
      // so a single PostHog query (`minGrade > 0`) works on both platforms.
      // `setterCount` is the size of the setter filter (0 = none, like web).
      minGrade: filters.minGrade ?? 0,
      maxGrade: filters.maxGrade ?? 0,
      // Which grades the climber reads. Under V grades the grade row groups
      // grades with one label, so a "V0" pick is minGrade 10, maxGrade 12 there
      // and reads as a range without this.
      gradeFormat,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      setterCount: filters.setter?.length ?? 0,
      minAscents: filters.minAscents ?? 0,
      minRating: filters.minRating ?? 0,
      // Zero-result filter snapshot: the fields above already cover
      // grade/sort/setter/ascents/rating unconditionally, so this only adds the
      // *remaining* filter dimensions, and only on a dead end — the signal for
      // "which filter caused this search to come up empty".
      ...(isZeroResult && {
        zeroResultStatus: filters.status ?? null,
        zeroResultGradeAccuracy: filters.gradeAccuracy ?? null,
        zeroResultOnlyTallClimbs: filters.onlyTallClimbs ?? false,
        zeroResultOnlyWideClimbs: filters.onlyWideClimbs ?? false,
        zeroResultOnlyWithBetaVideos: filters.onlyWithBetaVideos ?? false,
        zeroResultIncludeOtherAngles: filters.includeOtherAngles ?? false,
        zeroResultBoulders: filters.boulders ?? true,
        zeroResultRoutes: filters.routes ?? false,
        zeroResultHideAttempted: filters.hideAttempted ?? false,
        zeroResultHideCompleted: filters.hideCompleted ?? false,
        zeroResultShowOnlyAttempted: filters.showOnlyAttempted ?? false,
        zeroResultShowOnlyCompleted: filters.showOnlyCompleted ?? false,
        zeroResultOnlyBenchmarks: boardFilters.onlyBenchmarks ?? false,
        zeroResultHasHoldsFilter: !!(boardFilters.holdsFilter && Object.keys(boardFilters.holdsFilter).length > 0),
        zeroResultHasZoneFilter: boardFilters.zoneBox != null,
        zeroResultZoneMode: boardFilters.zoneMode ?? null,
        zeroResultHasSetterIdFilter: boardFilters.setterId != null,
      }),
    });
  }, [
    firstSearchPage,
    isPlaceholderData,
    showFilters,
    climbCount,
    name,
    filters,
    boardFilters,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    gradeFormat,
  ]);
}
