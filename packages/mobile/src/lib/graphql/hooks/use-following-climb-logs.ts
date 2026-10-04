import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_FOLLOWING_CLIMB_ASCENTS,
  type GetFollowingClimbAscentsQueryResponse,
  type GetFollowingClimbAscentsQueryVariables,
} from '@boardsesh/graphql/operations';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { getHttpClient } from '../client';
import { followingClimbLogsQueryKey } from '../query-keys';

/**
 * Logs on one climb from the climbers the viewer follows: up to the 100 newest
 * logs across every angle, plus counts that cover all of them.
 *
 * Network only, on purpose. Other climbers' logs are never synced to the phone,
 * and whether the viewer may see a spray wall's logs is the server's call on
 * every request, so this never goes through `offlineAwareRequest` and has no
 * local reader. With no signal the card shows a placard instead.
 *
 * No `placeholderData`: a new climb or a new account must never show the rows
 * the previous key held.
 *
 * Off in screenshot mode, so store captures need no recorded response for it.
 *
 * Callers branch on `isLoading` or `fetchStatus`, never `isPending`: a disabled
 * query stays `pending` forever. `isIdle` says "this hook is not asking".
 */
export function useFollowingClimbLogs(boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) {
  const { userId: viewerId } = useStoredUserId(true);
  const enabled =
    (options?.enabled ?? true) && !!viewerId && !!climbUuid && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1';
  const query = useQuery({
    queryKey: followingClimbLogsQueryKey(viewerId, boardName, climbUuid),
    queryFn: () =>
      getHttpClient().request<GetFollowingClimbAscentsQueryResponse, GetFollowingClimbAscentsQueryVariables>(
        GET_FOLLOWING_CLIMB_ASCENTS,
        { input: { boardType: boardName, climbUuid: climbUuid! } },
      ),
    select: (response) => response.followingClimbAscents,
    enabled,
    staleTime: 5 * 60_000,
  });
  return { ...query, isIdle: !enabled };
}

/**
 * True once `climbUuid` has stayed the same for `ms`. A fast swipe through a
 * queue passes a dozen climbs in a second; gating a per-climb request on this
 * sends one for the climb the climber stops on, not one per climb passed.
 */
export function useClimbDwell(climbUuid: string, ms = 600): boolean {
  const [dwelledUuid, setDwelledUuid] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDwelledUuid(climbUuid), ms);
    return () => clearTimeout(timer);
  }, [climbUuid, ms]);
  // Compared, not reset in the effect, so the first render on a new climb
  // already reads false.
  return dwelledUuid === climbUuid;
}
