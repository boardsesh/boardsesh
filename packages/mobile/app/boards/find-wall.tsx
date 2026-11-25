// The gym-first create flow's find step (#8151): without `gymUuid`, find the
// gym ("Find your gym's board"); with it, that gym's walls. A gym page's "Set
// up a board" opens straight on its walls (`entry=gym_page`). Only reachable
// with the `create-board-gym-first` flag on.

import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { toBoardName } from '@boardsesh/board-config';
import { FindWallGymSearch } from '../../src/components/board-discovery/FindWallGymSearch';
import { GymWallList } from '../../src/components/board-discovery/GymWallList';
import { isPickableBoardType } from '../../src/lib/boards/find-wall-state';
import { boardFlowTicket, claimBoardFlowAbandonment } from '../../src/lib/boards/board-create-flow';
import { track } from '../../src/lib/analytics';
import { useCreateBoardGymFirstEnabled } from '../../src/providers/feature-flags-provider';

export default function FindWall() {
  const params = useLocalSearchParams<{
    gymUuid?: string;
    boardType?: string;
    returnTo?: string;
    source?: string;
    /** `gym_page` when a gym page opened this on its walls. */
    entry?: string;
  }>();
  const gymUuid = typeof params.gymUuid === 'string' && params.gymUuid.length > 0 ? params.gymUuid : null;
  const parsedType = toBoardName(params.boardType);
  const initialBoardType = isPickableBoardType(parsedType) ? parsedType : null;

  // Flag off (a deep link, a stale route): the builder as it was, decided at
  // mount so a flag that resolves later never swaps the screen out.
  const router = useRouter();
  const gymFirstEnabled = useCreateBoardGymFirstEnabled();
  const [redirectToBuilder] = useState(() => !gymFirstEnabled);
  useEffect(() => {
    if (!redirectToBuilder) return;
    const builderParams: Record<string, string> = {};
    if (params.returnTo !== undefined) builderParams.returnTo = params.returnTo;
    if (params.source !== undefined) builderParams.source = params.source;
    router.replace({ pathname: '/boards/create', params: builderParams });
    // Once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `Board Builder Abandoned` at step `find`, unless a wall was taken or a
  // deeper screen already reported (board-create-flow.ts).
  useEffect(() => {
    const openedAtMs = Date.now();
    const ticket = boardFlowTicket();
    return () => {
      if (redirectToBuilder || !claimBoardFlowAbandonment(ticket)) return;
      track(SHARED_EVENTS.BoardBuilderAbandoned, {
        kind: 'gym',
        step: 'find',
        openedFrom: params.source ?? null,
        secondsOpen: Math.round((Date.now() - openedAtMs) / 1000),
      });
    };
    // Once per screen: the route's params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (redirectToBuilder) return null;
  if (gymUuid) {
    return (
      <GymWallList
        gymUuid={gymUuid}
        initialBoardType={initialBoardType}
        returnTo={params.returnTo}
        source={params.source}
        entry={params.entry === 'gym_page' ? 'gym_page' : 'find_step'}
      />
    );
  }
  return <FindWallGymSearch initialBoardType={initialBoardType} returnTo={params.returnTo} source={params.source} />;
}
