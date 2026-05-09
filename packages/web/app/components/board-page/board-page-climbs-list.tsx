'use client';
import React, { useMemo, useEffect, useRef } from 'react';
import type { Climb, ParsedBoardRouteParameters, BoardDetails, SearchRequestPagination } from '@/app/lib/types';
import { useQueueActions, useCurrentClimb, useSearchData } from '../graphql-queue';
import ClimbsList from './climbs-list';
import { stabilizeClimbArrayRef } from './climb-list-utils';
import RecentSearchPills from '../search-drawer/recent-search-pills';
import AngleSelector from './angle-selector';
import { searchParamsToUrlParams } from '@/app/lib/url-utils';

type BoardPageClimbsListProps = ParsedBoardRouteParameters & {
  boardDetails: BoardDetails;
  initialClimbs: Climb[];
};

const createSearchResetKey = (searchParams: SearchRequestPagination) => {
  return searchParamsToUrlParams({ ...searchParams, page: 0 }).toString();
};

const BoardPageClimbsList = ({
  boardDetails,
  initialClimbs,
  board_name,
  layout_id: _layout_id,
  size_id: _size_id,
  set_ids: _set_ids,
  angle,
}: BoardPageClimbsListProps) => {
  const { currentClimb } = useCurrentClimb();
  const { climbSearchParams, climbSearchResults, hasMoreResults, hasDoneFirstFetch, isFetchingClimbs } =
    useSearchData();
  const { setCurrentClimb, addToQueue, fetchMoreClimbs } = useQueueActions();

  const searchResetKey = useMemo(() => createSearchResetKey(climbSearchParams), [climbSearchParams]);
  const previousSearchResetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousSearchResetKeyRef.current === null) {
      previousSearchResetKeyRef.current = searchResetKey;
      return;
    }

    if (previousSearchResetKeyRef.current !== searchResetKey) {
      previousSearchResetKeyRef.current = searchResetKey;
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [searchResetKey]);

  // Queue Context provider uses React Query infinite to fetch results, which can only happen clientside.
  // That data equals null at the start, so when its null we use the initialClimbs array which we
  // fill on the server side in the page component. This way the user never sees a loading state for
  // the climb list.
  // Deduplicate climbs by uuid to prevent React key warnings during hydration/re-renders
  const prevClimbsRef = useRef<Climb[]>([]);
  const climbs = useMemo(() => {
    const rawClimbs = !hasDoneFirstFetch ? initialClimbs : climbSearchResults || [];
    const seen = new Set<string>();
    const deduped = rawClimbs.filter((climb) => {
      if (seen.has(climb.uuid)) return false;
      seen.add(climb.uuid);
      return true;
    });

    // Return the previous reference when content hasn't changed to avoid
    // triggering downstream progressive rendering during SSR→client handoff.
    const stable = stabilizeClimbArrayRef(deduped, prevClimbsRef.current);
    if (stable !== deduped) return stable;

    prevClimbsRef.current = deduped;
    return deduped;
  }, [hasDoneFirstFetch, initialClimbs, climbSearchResults]);

  const headerInline = useMemo(() => <RecentSearchPills />, []);

  const angleSelectorElement = useMemo(
    () => (
      <AngleSelector
        boardName={board_name}
        boardDetails={boardDetails}
        currentAngle={angle}
        currentClimb={currentClimb}
      />
    ),
    [board_name, boardDetails, angle, currentClimb],
  );

  return (
    <ClimbsList
      boardDetails={boardDetails}
      initialImageCount={initialClimbs.length}
      climbs={climbs}
      selectedClimbUuid={currentClimb?.uuid}
      isFetching={isFetchingClimbs}
      hasMore={hasMoreResults}
      onClimbSelect={setCurrentClimb}
      addToQueue={addToQueue}
      onLoadMore={fetchMoreClimbs}
      headerInline={headerInline}
      angleSelector={angleSelectorElement}
      showBottomSpacer
    />
  );
};

export default BoardPageClimbsList;
