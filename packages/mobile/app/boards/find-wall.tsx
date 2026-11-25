// The gym-first create flow's find step (#8151): without `gymUuid`, find the
// gym ("Find your gym's board", the map and search of `GymStep`); with it,
// that gym's walls. A gym page's "Set up a board" opens straight on its walls
// (`entry=gym_page`). Only reachable with the `create-board-gym-first` flag on.

import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName, Gym } from '@boardsesh/shared-schema';
import { GymStep } from '../../src/components/board-discovery/gym-step/GymStep';
import { GymWallList } from '../../src/components/board-discovery/GymWallList';
import { isPickableBoardType } from '../../src/lib/boards/find-wall-state';
import { boardFlowTicket, claimBoardFlowAbandonment } from '../../src/lib/boards/board-create-flow';
import { track } from '../../src/lib/analytics';
import { useCreateBoardGymFirstEnabled } from '../../src/providers/feature-flags-provider';
import { useAuth } from '../../src/providers/auth-provider';

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

  // A gym picked on the map: its walls, on this same route. The type chosen
  // there carries on, so the wall list opens on it.
  const { isAuthenticated } = useAuth();
  const routeParams = useCallback(
    (boardType: BoardName | null, extra: Record<string, string>) => {
      const nextParams: Record<string, string> = { ...extra };
      if (boardType) nextParams.boardType = boardType;
      if (params.returnTo !== undefined) nextParams.returnTo = params.returnTo;
      if (params.source !== undefined) nextParams.source = params.source;
      return nextParams;
    },
    [params.returnTo, params.source],
  );
  const onPickGym = useCallback(
    (gym: Gym, boardType: BoardName | null) =>
      router.push({ pathname: '/boards/find-wall', params: routeParams(boardType, { gymUuid: gym.uuid }) }),
    [router, routeParams],
  );
  // "Add my gym": the builder, opened on its location so the climber can name
  // the gym and place it. Adding needs an account.
  const onAddGym = useCallback(
    (boardType: BoardName | null) => {
      if (!isAuthenticated) {
        router.push('/auth/login');
        return;
      }
      router.push({ pathname: '/boards/create', params: routeParams(boardType, { kind: 'gym', focusLocation: '1' }) });
    },
    [isAuthenticated, router, routeParams],
  );

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
  return <GymStep initialBoardType={initialBoardType} onPickGym={onPickGym} onAddGym={onAddGym} />;
}
