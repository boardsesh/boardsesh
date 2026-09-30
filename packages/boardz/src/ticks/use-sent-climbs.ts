import { useQuery } from '@tanstack/react-query';
import { GET_USER_TICKS, type GetUserTicksQueryResponse } from '@boardsesh/graphql/operations/ticks';
import { graphqlRequest } from '../api/graphql-client';
import { useAuth } from '../auth/auth-provider';
import type { ActiveBoard } from '../board/active-board';

const SENT_STALE_MS = 5 * 60 * 1000;

/**
 * Climbs the signed-in climber has sent on this board at its current angle,
 * for solid grade tags. Keyed under `userTicks`, so logging a climb refreshes it.
 */
export function useSentClimbs(board: ActiveBoard | null): ReadonlySet<string> {
  const { profile } = useAuth();
  const userId = profile?.id;
  const boardType = board?.boardName;
  const ticks = useQuery({
    queryKey: ['userTicks', userId, 'sent', boardType],
    queryFn: async () =>
      (await graphqlRequest<GetUserTicksQueryResponse>(GET_USER_TICKS, { userId, boardType })).userTicks,
    enabled: userId !== undefined && boardType !== undefined,
    staleTime: SENT_STALE_MS,
  });
  const sent = new Set<string>();
  for (const tick of ticks.data ?? []) {
    if (tick.status !== 'attempt' && tick.angle === board?.angle) sent.add(tick.climbUuid);
  }
  return sent;
}
