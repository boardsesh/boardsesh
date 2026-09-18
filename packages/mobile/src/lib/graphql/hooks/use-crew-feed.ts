import { useInfiniteQuery } from '@tanstack/react-query';
import { GET_CREW_FEED } from '@boardsesh/graphql/operations';
import type { CrewFeedResult } from '@boardsesh/shared-schema';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { getHttpClient } from '../client';

/**
 * The zone the server draws each setter's day boundary in, so a climb published
 * at 23:00 local reads as today rather than as whatever UTC calls it.
 *
 * Resolved once at module load: Hermes ships a partial Intl, so this is wrapped
 * — a device whose zone can't be read falls back to the server's own UTC
 * default rather than taking the feed down with it.
 *
 * Once, deliberately. A climber who crosses a zone mid-session keeps the zone
 * the app started in until it restarts, which is the trade for not re-reading
 * Intl on every render or wiring a foreground listener. The zone is part of the
 * query key, so the restart re-fetches rather than serving the old grouping.
 */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const TIME_ZONE = deviceTimeZone();

export function useCrewFeed(enabled: boolean) {
  const { userId } = useStoredUserId(enabled);
  return useInfiniteQuery({
    // The zone keys the cache: a climber who crosses one must not keep reading
    // yesterday's grouping.
    queryKey: ['crewFeed', userId, TIME_ZONE],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<{ crewFeed: CrewFeedResult }>(GET_CREW_FEED, {
        input: { limit: 20, cursor: pageParam, timeZone: TIME_ZONE },
      }),
    getNextPageParam: (lastPage) => (lastPage.crewFeed.hasMore ? (lastPage.crewFeed.cursor ?? undefined) : undefined),
    enabled: enabled && !!userId,
  });
}
