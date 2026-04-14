'use client';
import React, { useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Climb, ParsedBoardRouteParameters, BoardDetails } from '@/app/lib/types';
import { useQueueActions, useCurrentClimb, useSearchData } from '../graphql-queue';
import ClimbsListShell from './climbs-list-shared';
import ListViewContent from './list-view-content';
import { stabilizeClimbArrayRef } from './climb-list-utils';
import RecentSearchPills from '../search-drawer/recent-search-pills';
import AngleSelector from './angle-selector';

type BoardPageListViewProps = ParsedBoardRouteParameters & {
  boardDetails: BoardDetails;
  initialClimbs: Climb[];
};

const BoardPageListView = ({
  boardDetails,
  initialClimbs,
  board_name,
  layout_id,
  size_id,
  set_ids,
  angle,
}: BoardPageListViewProps) => {
  const { currentClimb } = useCurrentClimb();
  const {
    climbSearchResults,
    hasMoreResults,
    hasDoneFirstFetch,
    isFetchingClimbs,
  } = useSearchData();
  const {
    setCurrentClimb,
    addToQueue,
    fetchMoreClimbs,
  } = useQueueActions();

  const searchParams = useSearchParams();
  const page = searchParams.get('page');

  // Scroll to top when search params reset to page 0
  useEffect(() => {
    if (page === '0' && hasDoneFirstFetch && isFetchingClimbs) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [page, hasDoneFirstFetch, isFetchingClimbs]);

  const prevClimbsRef = useRef<Climb[]>([]);
  const climbs = useMemo(() => {
    const rawClimbs = !hasDoneFirstFetch ? initialClimbs : climbSearchResults || [];
    const seen = new Set<string>();
    const deduped = rawClimbs.filter((climb) => {
      if (seen.has(climb.uuid)) return false;
      seen.add(climb.uuid);
      return true;
    });

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
    <ClimbsListShell
      viewMode="list"
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
    >
      {(contentProps) => <ListViewContent {...contentProps} />}
    </ClimbsListShell>
  );
};

export default BoardPageListView;
