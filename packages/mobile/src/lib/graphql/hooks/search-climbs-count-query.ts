import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../offline-request';
import { SEARCH_CLIMBS_COUNT, type SearchClimbsCountQueryResponse } from '../operations';
import { SEARCH_CLIMBS_COUNT_QUERY_KEY } from '../query-keys';

// A list's count barely moves while a climber taps through it, and on a board
// with no download each count is a Postgres query (docs/postgres-query-costs.md).
const TAP_COUNT_STALE_MS = 5 * 60 * 1000;

/**
 * The search count's cache key. `useSearchClimbsCount` and the player's
 * tap-time total share it, so a tap reuses a count the screen already holds.
 * `input` is the search as sent (after `withGradeSource`). A followed-setters
 * search is scoped to the account that asked, so its key carries the user id.
 */
export function searchClimbsCountQueryKey(input: ClimbSearchInput, userId: string | null | undefined) {
  return [...SEARCH_CLIMBS_COUNT_QUERY_KEY, input, ...(input.onlyFollowedAuthors ? [userId] : [])] as const;
}

/**
 * The count for the player's "4 of 230", read through the query cache: repeat
 * taps on the same search within five minutes send no request.
 */
export async function fetchCachedSearchClimbsCount(
  queryClient: QueryClient,
  input: ClimbSearchInput,
  userId: string | null | undefined,
): Promise<number> {
  const response = await queryClient.fetchQuery({
    queryKey: searchClimbsCountQueryKey(input, userId),
    queryFn: () => offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input }),
    staleTime: TAP_COUNT_STALE_MS,
  });
  return response.searchClimbs.totalCount;
}

/** {@link fetchCachedSearchClimbsCount} on the app's query client. */
export function useFetchCachedSearchClimbsCount(): (
  input: ClimbSearchInput,
  userId: string | null | undefined,
) => Promise<number> {
  const queryClient = useQueryClient();
  return useCallback(
    (input: ClimbSearchInput, userId: string | null | undefined) =>
      fetchCachedSearchClimbsCount(queryClient, input, userId),
    [queryClient],
  );
}
