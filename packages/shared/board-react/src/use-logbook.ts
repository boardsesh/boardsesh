import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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

const NO_FETCHED_UUIDS: ReadonlySet<string> = new Set();

// Query clients whose cache already drops a board's fetched-uuid marker with
// its accumulated rows. One subscription per client, for the client's lifetime.
const clientsWithMarkerGuard = new WeakSet<QueryClient>();

/**
 * The fetched-uuid marker says "the accumulated rows answer for this climb".
 * It is shared by every `useLogbook` on the client, so it must never outlive
 * those rows: a marker without them reads as "fetched, no history", and a
 * repeat ascent can then be logged as a flash (#3940). Removing it from a cache
 * listener covers every way the rows can go (a prefix removal, an exact one,
 * `queryClient.clear()` on sign-out, garbage collection after a board switch)
 * whether or not a hook for that board is mounted at the time.
 */
function ensureMarkerIsRemovedWithRows(queryClient: QueryClient) {
  if (clientsWithMarkerGuard.has(queryClient)) return;
  clientsWithMarkerGuard.add(queryClient);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed') return;
    const [root, removedBoardName, kind] = event.query.queryKey;
    if (root !== 'logbook' || kind !== 'accumulated') return;
    queryClient.removeQueries({ queryKey: ['logbook', removedBoardName, 'fetched-climb-uuids'], exact: true });
  });
}

/**
 * Files a multi-climb batch under each climb's own single-climb fetch key. A
 * hook that later asks for one of those climbs alone (the play drawer) then
 * finds the answer in the cache and sends nothing. An invalidation marks these
 * entries stale like any other fetch, so that hook still re-reads the climb
 * after a tick lands from elsewhere.
 */
function fileBatchUnderSingleClimbKeys(
  queryClient: QueryClient,
  boardName: BoardName | null,
  batchUuids: string[],
  batchEntries: LogbookEntry[],
) {
  const entriesByClimb = new Map<string, LogbookEntry[]>();
  for (const entry of batchEntries) {
    const climbEntries = entriesByClimb.get(entry.climb_uuid);
    if (climbEntries) climbEntries.push(entry);
    else entriesByClimb.set(entry.climb_uuid, [entry]);
  }
  for (const uuid of batchUuids) {
    queryClient.setQueryData<LogbookEntry[]>(fetchLogbookQueryKey(boardName, [uuid]), entriesByClimb.get(uuid) ?? []);
  }
}

/**
 * Fetch logbook entries (ticks) for specific climbs.
 *
 * Uses incremental fetching: only fetches data for UUIDs that haven't been
 * fetched yet, and merges results into a stable accumulated React Query
 * entry. This prevents indicator flicker when new pages load, because
 * existing logbook data is never cleared during a fetch.
 *
 * The accumulated rows and the fetched-uuid marker are both shared cache
 * entries, so every instance on a board (the root board provider, an open play
 * drawer) reports the same `fetchedUuids`, and a climb one instance fetched in
 * a batch is not requested again by another.
 *
 * `boardName` is `BoardName | null` so callers that resolve their board
 * asynchronously (mobile) can pass null without juggling enabled gates —
 * a null board produces an inert query key and disables fetching.
 */
export function useLogbook(boardName: BoardName | null, climbUuids: string[]) {
  const { isAuthenticated, executeHttp } = useBoardAdapter();
  const queryClient = useQueryClient();
  const accumulatedKey = useMemo(() => accumulatedLogbookQueryKey(boardName), [boardName]);
  const fetchedUuidsKey = useMemo(() => fetchedLogbookClimbUuidsQueryKey(boardName), [boardName]);
  // The uuids THIS hook has sent a batch for. Only decides what its next batch
  // leaves out; what the hook reports as fetched is the shared marker below.
  const fetchedUuidsRef = useRef<Set<string>>(new Set());
  const lastMergedRef = useRef<LogbookEntry[] | undefined>(undefined);
  const [invalidationCount, setInvalidationCount] = useState(0);
  // Which climbs the accumulated rows answer for, across every hook on this
  // board. Subscribed rather than read once because a climb with no ticks
  // merges an empty array: the accumulated logbook keeps its identity, so this
  // marker is the only thing that changes. Consumers need it to tell "fetched,
  // no history" from "not fetched yet" — without it, a repeat ascent reads as
  // a first-ever go until the fetch lands and can be logged as a flash (#3940).
  // Never fetched into: the merge effect below is its only writer.
  const fetchedUuidsQuery = useQuery<ReadonlySet<string>>({
    queryKey: fetchedUuidsKey,
    queryFn: async () => NO_FETCHED_UUIDS,
    staleTime: Infinity,
    enabled: false,
  });
  const fetchedUuids = fetchedUuidsQuery.data ?? NO_FETCHED_UUIDS;

  const isEnabled = isAuthenticated && boardName !== null;

  // Reset the fetched-uuid tracker whenever the active board changes. Without
  // this, switching boards (kilter → tension) would silently skip fetches
  // for any uuid the previous board had already pulled, leaving the new
  // board's logbook missing entries.
  const lastBoardRef = useRef<BoardName | null>(boardName);
  if (lastBoardRef.current !== boardName) {
    lastBoardRef.current = boardName;
    fetchedUuidsRef.current = new Set();
    lastMergedRef.current = undefined;
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

  // Declared ahead of the merge effect, so the guard is in place before this
  // hook can write a marker.
  useEffect(() => {
    ensureMarkerIsRemovedWithRows(queryClient);
  }, [queryClient]);

  // When fetch completes, merge new entries into the accumulated cache.
  // Mark UUIDs as fetched HERE, not in `queryFn`, so the query key stays
  // stable until the data is consumed — mutating the ref inside queryFn
  // would change the key on the resolved-query re-render and lose the data.
  useEffect(() => {
    if (!fetchQuery.data || fetchQuery.data === lastMergedRef.current) return;
    lastMergedRef.current = fetchQuery.data;
    const batchEntries = fetchQuery.data;

    newUuids.forEach((uuid) => fetchedUuidsRef.current.add(uuid));

    // Rows before the marker, so no subscriber can read a climb as fetched
    // ahead of its rows.
    queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) =>
      mergeLogbookEntries(existing, batchEntries),
    );
    // Mark these UUIDs as fetched (including those that returned no ticks).
    // Several consumers can fetch disjoint climb batches at once (the root
    // board provider plus an open drawer). Coverage is monotonic until the
    // accumulated cache is removed, so merge rather than letting the last
    // hook to finish clobber other hooks' authoritative markers. The Set keeps
    // its identity when the membership did not grow: this value sits on the
    // volatile logbook context, so a fresh identity re-renders every
    // subscriber — not worth paying for a re-fetch that added nothing.
    queryClient.setQueryData<ReadonlySet<string>>(fetchedUuidsKey, (existing) =>
      existing && newUuids.every((uuid) => existing.has(uuid)) ? existing : new Set([...(existing ?? []), ...newUuids]),
    );
    // A one-climb batch already sits under its own key.
    if (newUuids.length > 1) fileBatchUnderSingleClimbKeys(queryClient, boardName, newUuids, batchEntries);
  }, [fetchQuery.data, newUuids, accumulatedKey, fetchedUuidsKey, boardName, queryClient]);

  // Reset UUID tracking when the accumulated cache entry is removed
  // (explicit invalidation via useInvalidateLogbook). The shared marker goes
  // with it (`ensureMarkerIsRemovedWithRows`); the state bump re-renders this
  // hook, so it stops reporting the removed marker and fetches again.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'removed') return;

      const qk = event.query.queryKey;
      if (qk[0] !== accumulatedKey[0] || qk[1] !== accumulatedKey[1] || qk[2] !== accumulatedKey[2]) return;

      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      setInvalidationCount((c) => c + 1);
    });
    return unsubscribe;
  }, [queryClient, accumulatedKey]);

  // Reset on logout so a different user logging in doesn't see stale data.
  // Gated on the auth transition (not on `isEnabled` directly) — a board
  // changing from null → 'kilter' is not a logout and must not wipe caches.
  const lastAuthRef = useRef(isAuthenticated);
  useEffect(() => {
    if (lastAuthRef.current && !isAuthenticated) {
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      // Remove every per-board logbook entry. A different user may sign in.
      queryClient.removeQueries({ queryKey: ['logbook'] });
    }
    lastAuthRef.current = isAuthenticated;
  }, [isAuthenticated, queryClient]);

  // Re-runs the pending batch after a failure. A failed batch is never marked
  // fetched, so its key is unchanged and this is the same request again.
  const { refetch: refetchBatch } = fetchQuery;
  const refetch = useCallback(() => {
    void refetchBatch();
  }, [refetchBatch]);

  return {
    logbook,
    // Which climbs the logbook can actually answer for, whichever hook fetched
    // them. Absence means "not fetched yet", not "no ticks".
    fetchedUuids,
    isLoading: fetchQuery.isLoading && logbook.length === 0,
    error: fetchQuery.error,
    refetch,
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
