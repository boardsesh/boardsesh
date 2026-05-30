'use client';
import React, { useEffect, useMemo, useRef } from 'react';
import type { Climb, ParsedBoardRouteParameters, BoardDetails } from '@/app/lib/types';
import { useQueueActions, useCurrentClimb, useSearchData } from '../graphql-queue';
import ClimbsList from './climbs-list';
import { stabilizeClimbArrayRef } from './climb-list-utils';
import RecentSearchPills from '../search-drawer/recent-search-pills';
import AngleSelector from './angle-selector';
import { dispatchOpenPlayDrawer } from '../queue-control/play-drawer-event';
import { useOptionalBoardProvider } from '../board-provider/board-provider-context';

type BoardPageClimbsListProps = ParsedBoardRouteParameters & {
  boardDetails: BoardDetails;
  initialClimbs: Climb[];
  initialHasMore?: boolean;
  /**
   * When set, opens the PlayViewDrawer on the given climb immediately after
   * mount. Used by the /view/{climb_uuid} routes to render the list with the
   * drawer pre-opened on a shareable climb, replacing the old standalone
   * full-page climb-detail layout.
   */
  initialOpenClimb?: Climb | null;
};

const BoardPageClimbsList = ({
  boardDetails,
  initialClimbs,
  initialHasMore = false,
  initialOpenClimb = null,
  board_name,
  layout_id: _layout_id,
  size_id: _size_id,
  set_ids: _set_ids,
  angle,
}: BoardPageClimbsListProps) => {
  const { currentClimb } = useCurrentClimb();
  const { climbSearchResults, hasMoreResults, hasDoneFirstFetch, isFetchingClimbs } = useSearchData();
  const { addToQueue, fetchMoreClimbs } = useQueueActions();
  const getLogbook = useOptionalBoardProvider()?.getLogbook;

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

  const climbUuidsForLogbookKey = useMemo(
    () =>
      climbs
        .map((climb) => climb.uuid)
        .sort()
        .join(','),
    [climbs],
  );

  useEffect(() => {
    if (!getLogbook || climbUuidsForLogbookKey.length === 0) return;
    void getLogbook(climbUuidsForLogbookKey.split(','));
  }, [getLogbook, climbUuidsForLogbookKey]);

  // Open the play drawer on the requested climb when this component mounts
  // on a /view/{climb_uuid} route. The dispatch is deferred to the next
  // microtask so the QueueControlBar's drawer-open listener has a chance to
  // subscribe — both components' effects run in the same React commit when
  // the page hydrates, and the listener registration would otherwise race
  // the dispatch. Stash the climb in a ref so the effect deps can key on the
  // stable uuid identity instead of the object reference. Track the last
  // dispatched uuid (rather than a one-shot flag) so soft-navs back to the
  // same /view/{uuid} after a detour through /list still re-open the drawer.
  const initialOpenClimbUuid = initialOpenClimb?.uuid;
  const initialOpenClimbRef = useRef(initialOpenClimb);
  initialOpenClimbRef.current = initialOpenClimb;
  const lastDispatchedUuidRef = useRef<string | null>(null);
  useEffect(() => {
    const climb = initialOpenClimbRef.current;
    if (!climb) {
      lastDispatchedUuidRef.current = null;
      return;
    }
    if (lastDispatchedUuidRef.current === climb.uuid) return;
    lastDispatchedUuidRef.current = climb.uuid;
    queueMicrotask(() => {
      dispatchOpenPlayDrawer(climb);
    });
  }, [initialOpenClimbUuid]);

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
      hasMore={!hasDoneFirstFetch ? initialHasMore : hasMoreResults}
      addToQueue={addToQueue}
      onLoadMore={fetchMoreClimbs}
      headerInline={headerInline}
      angleSelector={angleSelectorElement}
      showBottomSpacer
    />
  );
};

export default BoardPageClimbsList;
