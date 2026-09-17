import { useInfiniteQuery } from '@tanstack/react-query';
import { GET_CREW_FEED } from '@boardsesh/graphql/operations';
import type { CrewFeedResult } from '@boardsesh/shared-schema';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { getHttpClient } from '../client';

export function useCrewFeed(enabled: boolean) {
  const { userId } = useStoredUserId(enabled);
  return useInfiniteQuery({
    queryKey: ['crewFeed', userId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<{ crewFeed: CrewFeedResult }>(GET_CREW_FEED, {
        input: { limit: 20, cursor: pageParam },
      }),
    getNextPageParam: (lastPage) => (lastPage.crewFeed.hasMore ? (lastPage.crewFeed.cursor ?? undefined) : undefined),
    enabled: enabled && !!userId,
  });
}
