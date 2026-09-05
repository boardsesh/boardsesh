import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { GET_TICKS, type GetTicksQueryVariables, type GetTicksQueryResponse } from '@boardsesh/graphql/operations';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardAdapter } from './adapter';
import {
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKey,
  fetchedLogbookClimbUuidsQueryKey,
  mergeLogbookEntries,
  toLogbookEntry,
  type LogbookEntry,
} from './logbook-keys';

function transformTicks(ticks: GetTicksQueryResponse['ticks']): LogbookEntry[] {
  return ticks.map(toLogbookEntry);
}

/**
 * Fetch logbook entries (ticks) for specific climbs.
 *
 * Uses incremental fetching: only fetches data for UUIDs that haven't been
 * fetched yet, and merges results into a stable accumulated React Query
 * entry. This prevents indicator flicker when new pages load, because
 * existing logbook data is never cleared during a fetch.
 *
 * `boardName` is `BoardName | null` so callers that resolve their board
 * asynchronously (mobile) can pass null without juggling enabled gates —
 * a null board produces an inert query key and disables fetching.
 */
export function useLogbook(boardName: BoardName | null, climbUuids: string[]) {
  const { isAuthenticated, canLogLocally, useLocalTickStore, executeHttp, getTicksLocal } = useBoardAdapter();
  const queryClient = useQueryClient();
  const accumulatedKey = useMemo(() => accumulatedLogbookQueryKey(boardName), [boardName]);
  const fetchedUuidsRef = useRef<Set<string>>(new Set());
  const lastMergedRef = useRef<LogbookEntry[] | undefined>(undefined);
  const [invalidationCount, setInvalidationCount] = useState(0);
  // Render-visible mirror of `fetchedUuidsRef`. The ref alone can't drive UI:
  // a climb with no ticks merges an empty array, so the accumulated logbook
  // keeps its identity and subscribers never re-render to observe the ref.
  // Consumers need to tell "fetched, no history" from "not fetched yet" —
  // without it, a repeat ascent reads as a first-ever go until the fetch lands
  // and can be logged as a flash (#3940).
  const [fetchedUuids, setFetchedUuids] = useState<ReadonlySet<string>>(() => new Set());

  const isEnabled = (isAuthenticated || canLogLocally === true) && boardName !== null;

  // Reset the fetched-uuid tracker whenever the active board changes. Without
  // this, switching boards (kilter → tension) would silently skip fetches
  // for any uuid the previous board had already pulled, leaving the new
  // board's logbook missing entries.
  const lastBoardRef = useRef<BoardName | null>(boardName);
  if (lastBoardRef.current !== boardName) {
    lastBoardRef.current = boardName;
    fetchedUuidsRef.current = new Set();
    lastMergedRef.current = undefined;
    // Cleared in the same synchronous block as the ref (the React
    // "adjust state when a prop changes" pattern) rather than in an effect,
    // so no render can observe the previous board's uuids as fetched.
    setFetchedUuids(new Set());
  }

  const accumulatedQuery = useQuery<LogbookEntry[]>({
    queryKey: accumulatedKey,
    queryFn: async () => [],
    initialData: [],
    staleTime: Infinity,
    enabled: false,
  });
  const logbook = accumulatedQuery.data ?? [];

  // Determine which UUIDs haven't been fetched yet. `invalidationCount` forces
  // recomputation after cache-removal clears `fetchedUuidsRef`, since
  // `climbUuids` / `isEnabled` may not have changed at that moment.
  // `invalidationCount` in the deps array (instead of `fetchedUuidsRef`)
  // forces this memo to recompute after the cache-removal effect clears
  // the ref — a closure over the ref alone wouldn't trigger a recompute
  // when `climbUuids` / `isEnabled` are unchanged at that moment.
  const newUuids = useMemo(
    () => (isEnabled ? climbUuids.filter((uuid) => !fetchedUuidsRef.current.has(uuid)) : []),
    [climbUuids, isEnabled, invalidationCount],
  );

  const fetchQuery = useQuery({
    queryKey: fetchLogbookQueryKey(boardName, newUuids),
    queryFn: async ({ queryKey }: { queryKey: readonly unknown[] }): Promise<LogbookEntry[]> => {
      // Extract UUIDs from query key to avoid stale-closure issues.
      const uuidsString = typeof queryKey[3] === 'string' ? queryKey[3] : '';
      const uuidsToFetch = uuidsString ? uuidsString.split(',') : [];

      if (uuidsToFetch.length === 0 || !boardName) return [];

      if (useLocalTickStore || canLogLocally) {
        if (!getTicksLocal) throw new Error('Local logbook unavailable');
        return transformTicks(await getTicksLocal(boardName, uuidsToFetch));
      }

      if (!isAuthenticated) throw new Error('Not authenticated');

      const variables: GetTicksQueryVariables = {
        input: {
          boardType: boardName,
          climbUuids: uuidsToFetch,
        },
      };
      const response = await executeHttp<GetTicksQueryResponse, GetTicksQueryVariables>(GET_TICKS, variables);
      return transformTicks(response.ticks);
    },
    enabled: isEnabled && newUuids.length > 0,
    // Each batch is fetched once; accumulation handles deduplication.
    staleTime: Infinity,
  });

  // When fetch completes, merge new entries into the accumulated cache.
  // Mark UUIDs as fetched HERE, not in `queryFn`, so the query key stays
  // stable until the data is consumed — mutating the ref inside queryFn
  // would change the key on the resolved-query re-render and lose the data.
  useEffect(() => {
    if (!fetchQuery.data || fetchQuery.data === lastMergedRef.current) return;
    lastMergedRef.current = fetchQuery.data;

    // Mark these UUIDs as fetched (including those that returned no ticks).
    const sizeBefore = fetchedUuidsRef.current.size;
    newUuids.forEach((uuid) => fetchedUuidsRef.current.add(uuid));
    // Only publish a new Set when the membership actually grew. This value sits
    // on the volatile logbook context, so a fresh identity re-renders every
    // subscriber — not worth paying for a re-fetch that added nothing.
    if (fetchedUuidsRef.current.size !== sizeBefore) {
      const nextFetchedUuids = new Set(fetchedUuidsRef.current);
      setFetchedUuids(nextFetchedUuids);
      // Several consumers can fetch disjoint climb batches at once (the root
      // board provider plus an open drawer). Coverage is monotonic until the
      // accumulated cache is removed, so merge rather than letting the last
      // hook to finish clobber other hooks' authoritative markers.
      queryClient.setQueryData<ReadonlySet<string>>(
        fetchedLogbookClimbUuidsQueryKey(boardName),
        (existing) => new Set([...(existing ?? []), ...nextFetchedUuids]),
      );
    }

    queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) =>
      mergeLogbookEntries(existing, fetchQuery.data),
    );
  }, [fetchQuery.data, newUuids, accumulatedKey, queryClient]);

  // Reset UUID tracking when the accumulated cache entry is removed
  // (explicit invalidation via useInvalidateLogbook).
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'removed') return;

      const qk = event.query.queryKey;
      if (qk[0] !== accumulatedKey[0] || qk[1] !== accumulatedKey[1] || qk[2] !== accumulatedKey[2]) return;

      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      setFetchedUuids(new Set());
      queryClient.removeQueries({ queryKey: fetchedLogbookClimbUuidsQueryKey(boardName), exact: true });
      setInvalidationCount((c) => c + 1);
    });
    return unsubscribe;
  }, [queryClient, accumulatedKey]);

  // Reset on logout so a different user logging in doesn't see stale data.
  // Gated on the auth transition (not on `isEnabled` directly) — a board
  // changing from null → 'kilter' is not a logout and must not wipe caches.
  const hasLogbookAccess = isAuthenticated || canLogLocally === true;
  const lastAuthRef = useRef(hasLogbookAccess);
  useEffect(() => {
    if (lastAuthRef.current && !hasLogbookAccess) {
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      setFetchedUuids(new Set());
      // Remove every per-board logbook entry. A different user may sign in.
      queryClient.removeQueries({ queryKey: ['logbook'] });
    }
    lastAuthRef.current = hasLogbookAccess;
  }, [hasLogbookAccess, queryClient]);

  return {
    logbook,
    // Which climbs the logbook can actually answer for. Absence means "not
    // fetched yet", not "no ticks".
    fetchedUuids,
    isLoading: fetchQuery.isLoading && logbook.length === 0,
    error: fetchQuery.error,
  };
}

/**
 * Returns a function to invalidate logbook queries for a given board.
 * Removes all logbook queries from the cache, triggering the cache
 * subscription in `useLogbook` to reset `fetchedUuidsRef` and re-fetch.
 */
export function useInvalidateLogbook(boardName: BoardName | null) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.removeQueries({ queryKey: ['logbook', boardName] });
  }, [queryClient, boardName]);
}
