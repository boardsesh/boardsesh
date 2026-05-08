'use client';
import React, { useMemo, useRef } from 'react';
import type { Climb, ParsedBoardRouteParameters, BoardDetails } from '@/app/lib/types';
import { useQueueActions, useCurrentClimb, useQueueData, useSearchData, useSessionData } from '../graphql-queue';
import { usePartyProfile } from '../party-manager/party-profile-context';
import ClimbsList from './climbs-list';
import { stabilizeClimbArrayRef } from './climb-list-utils';
import RecentSearchPills from '../search-drawer/recent-search-pills';
import AngleSelector from './angle-selector';

type BoardPageClimbsListProps = ParsedBoardRouteParameters & {
  boardDetails: BoardDetails;
  initialClimbs: Climb[];
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
  const { picks } = useQueueData();
  const { climbSearchResults, hasMoreResults, hasDoneFirstFetch, isFetchingClimbs } = useSearchData();
  const { isSessionActive, users, clientId } = useSessionData();
  const { setCurrentClimb, addToQueue, fetchMoreClimbs } = useQueueActions();
  const { profile } = usePartyProfile();

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

  const selectedClimbUuid = useMemo(() => {
    if (!isSessionActive) return currentClimb?.uuid ?? null;

    const ids = new Set<string>();
    if (clientId) ids.add(clientId);
    if (profile?.id) ids.add(profile.id);
    const me = users.find((user) => user.id === clientId || (!!profile?.id && user.userId === profile.id));
    if (me?.userId) ids.add(me.userId);

    for (const id of ids) {
      const pickUuid = picks[id]?.item.climb.uuid;
      if (pickUuid) return pickUuid;
    }

    return currentClimb?.uuid ?? null;
  }, [clientId, currentClimb?.uuid, isSessionActive, picks, profile?.id, users]);

  return (
    <ClimbsList
      boardDetails={boardDetails}
      initialImageCount={initialClimbs.length}
      climbs={climbs}
      selectedClimbUuid={selectedClimbUuid}
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
