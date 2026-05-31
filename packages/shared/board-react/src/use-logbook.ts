import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { GET_TICKS, type GetTicksQueryVariables, type GetTicksQueryResponse } from '@boardsesh/graphql/operations';
import type { LogbookDeps } from './types';
import {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKey,
  type LogbookEntry,
} from './transforms';

function transformTicks(ticks: GetTicksQueryResponse['ticks']): LogbookEntry[] {
  return ticks.map(toLogbookEntry);
}

/**
 * Renderer-agnostic logbook fetch. Ported from web's
 * `packages/web/app/hooks/use-logbook.ts`; platform I/O (auth state, GraphQL
 * request) is injected via `deps`, so the exact React Query machinery is shared
 * by web and mobile.
 *
 * Uses incremental fetching: only fetches data for UUIDs not yet fetched, and
 * merges results into a stable accumulated React Query entry, so existing
 * logbook data is never cleared mid-fetch (no indicator flicker on pagination).
 *
 * `boardName` is nullable (mobile resolves its active board asynchronously);
 * fetching stays disabled until it resolves.
 */
export function useLogbook(deps: LogbookDeps, boardName: string | null, climbUuids: string[]) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const queryClient = useQueryClient();
  const accumulatedKey = useMemo(() => accumulatedLogbookQueryKey(boardName), [boardName]);
  const fetchedUuidsRef = useRef<Set<string>>(new Set());
  const [invalidationCount, setInvalidationCount] = useState(0);

  // Reactive gate (read directly so `enabled` updates on auth/board change).
  const isEnabled = deps.isAuthenticated && boardName !== null;

  const accumulatedQuery = useQuery<LogbookEntry[]>({
    queryKey: accumulatedKey,
    queryFn: async () => [],
    initialData: [],
    staleTime: Infinity,
    enabled: false,
  });
  const logbook = accumulatedQuery.data ?? [];

  // Determine which UUIDs haven't been fetched yet.
  // invalidationCount forces recomputation after cache invalidation clears
  // fetchedUuidsRef, since climbUuids/isEnabled may not have changed.
  const newUuids = useMemo(
    () => (isEnabled ? climbUuids.filter((uuid) => !fetchedUuidsRef.current.has(uuid)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidationCount forces recomputation after cache invalidation clears fetchedUuidsRef
    [climbUuids, isEnabled, invalidationCount],
  );

  // Fetch only the new UUIDs
  const fetchQuery = useQuery({
    queryKey: fetchLogbookQueryKey(boardName, newUuids),
    queryFn: async ({ queryKey }: { queryKey: readonly unknown[] }): Promise<LogbookEntry[]> => {
      // Extract UUIDs from query key to avoid stale closure issues
      const uuidsString = queryKey[3] as string;
      const uuidsToFetch = uuidsString ? uuidsString.split(',') : [];

      if (uuidsToFetch.length === 0 || boardName === null) return [];

      const variables: GetTicksQueryVariables = {
        input: {
          boardType: boardName,
          climbUuids: uuidsToFetch,
        },
      };
      const response = await depsRef.current.requestHttp<GetTicksQueryResponse>(
        GET_TICKS,
        variables as unknown as Record<string, unknown>,
      );
      return transformTicks(response.ticks);
    },
    enabled: isEnabled && newUuids.length > 0,
    // Each batch is fetched once; accumulation handles deduplication
    staleTime: Infinity,
  });

  // When fetch completes, merge new entries into the accumulated cache.
  // IMPORTANT: Mark UUIDs as fetched here (not in queryFn) so the query key
  // remains stable until the data is consumed. If we mutated the ref inside
  // queryFn, useMemo would recompute newUuids on the re-render triggered by
  // the resolved query, changing the query key before the data could be read.
  const lastMergedRef = useRef<LogbookEntry[] | undefined>(undefined);
  useEffect(() => {
    if (!fetchQuery.data || fetchQuery.data === lastMergedRef.current) return;
    lastMergedRef.current = fetchQuery.data;

    // Mark these UUIDs as fetched (including those with no ticks)
    newUuids.forEach((uuid) => fetchedUuidsRef.current.add(uuid));

    queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) =>
      mergeLogbookEntries(existing, fetchQuery.data),
    );
  }, [fetchQuery.data, newUuids, accumulatedKey, queryClient]);

  // Reset per-board fetch tracking when the board ACTUALLY changes. The
  // accumulated cache is keyed by board, so the fetched-UUID set must be too —
  // otherwise switching boards (kilter → tension) leaves the new board unable to
  // fetch UUIDs the previous board had already marked fetched. Skips the initial
  // mount (prevKeyRef starts equal) so this is a pure no-op on web — which
  // remounts per route and never switches board in place — and only fires on
  // mobile's in-place board switch. Bumping invalidationCount forces `newUuids`
  // to recompute against the cleared set.
  const prevAccumulatedKeyRef = useRef(accumulatedKey);
  useEffect(() => {
    if (prevAccumulatedKeyRef.current === accumulatedKey) return;
    prevAccumulatedKeyRef.current = accumulatedKey;
    fetchedUuidsRef.current = new Set();
    lastMergedRef.current = undefined;
    setInvalidationCount((count) => count + 1);
  }, [accumulatedKey]);

  // Reset UUID tracking when the accumulated cache entry is removed.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'removed') return;

      const qk = event.query.queryKey;
      if (qk[0] !== accumulatedKey[0] || qk[1] !== accumulatedKey[1] || qk[2] !== accumulatedKey[2]) return;

      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      setInvalidationCount((count) => count + 1);
    });
    return unsubscribe;
  }, [queryClient, accumulatedKey]);

  // Reset when auth is lost (e.g., user logs out) so that a different user
  // logging in doesn't see stale data. Uses removeQueries to also clear fetch
  // cache entries, ensuring re-auth triggers actual re-fetches instead of
  // returning stale cached data.
  useEffect(() => {
    if (!isEnabled) {
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      queryClient.removeQueries({ queryKey: ['logbook', boardName] });
    }
  }, [isEnabled, boardName, queryClient]);

  return {
    logbook,
    isLoading: fetchQuery.isLoading && logbook.length === 0,
    error: fetchQuery.error,
  };
}

/**
 * Returns a function to invalidate logbook queries for a given board. Removes
 * all logbook queries from the cache, which triggers the cache subscription in
 * useLogbook to reset fetchedUuidsRef and re-fetch.
 */
export function useInvalidateLogbook(boardName: string | null) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.removeQueries({ queryKey: ['logbook', boardName] });
  }, [queryClient, boardName]);
}
