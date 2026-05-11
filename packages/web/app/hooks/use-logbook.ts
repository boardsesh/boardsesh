'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_TICKS, type GetTicksQueryVariables, type GetTicksQueryResponse } from '@/app/lib/graphql/operations';
import type { BoardName, ClimbUuid } from '@/app/lib/types';
import { listAllLocalTicks, type LocalTick } from '@/app/lib/local-ticks-db';

// Tick status type matching the database enum
export type TickStatus = 'flash' | 'send' | 'attempt';

// Logbook entry representing a user's tick on a climb
export type LogbookEntry = {
  uuid: string;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  tries: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  climbed_at: string;
  is_ascent: boolean;
  status?: TickStatus;
  upvotes: number;
  downvotes: number;
  commentCount: number;
};

type LogbookSourceTick = {
  uuid: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
};

export function toLogbookEntry(tick: LogbookSourceTick): LogbookEntry {
  return {
    uuid: tick.uuid,
    climb_uuid: tick.climbUuid,
    angle: tick.angle,
    is_mirror: tick.isMirror,
    tries: tick.attemptCount,
    quality: tick.quality,
    difficulty: tick.difficulty,
    comment: tick.comment,
    climbed_at: tick.climbedAt,
    is_ascent: tick.status === 'flash' || tick.status === 'send',
    status: tick.status,
    upvotes: tick.upvotes ?? 0,
    downvotes: tick.downvotes ?? 0,
    commentCount: tick.commentCount ?? 0,
  };
}

function transformTicks(ticks: GetTicksQueryResponse['ticks']): LogbookEntry[] {
  return ticks.map(toLogbookEntry);
}

function localTickToLogbookEntry(tick: LocalTick): LogbookEntry {
  return toLogbookEntry({
    uuid: tick.uuid,
    climbUuid: tick.climbUuid,
    angle: tick.angle,
    isMirror: tick.isMirror,
    status: tick.status,
    attemptCount: tick.attemptCount,
    quality: tick.quality,
    difficulty: tick.difficulty,
    comment: tick.comment,
    climbedAt: tick.climbedAt,
  });
}

export function mergeLogbookEntries(existing: LogbookEntry[], incoming: LogbookEntry[]): LogbookEntry[] {
  if (incoming.length === 0) return existing;

  const existingUuids = new Set(existing.map((entry) => entry.uuid));
  const uniqueIncoming = incoming.filter((entry) => !existingUuids.has(entry.uuid));

  if (uniqueIncoming.length === 0) return existing;
  return [...existing, ...uniqueIncoming];
}

/**
 * Stable key for accumulated logbook data. This is the single source of truth
 * for board-route tick rendering.
 */
export function accumulatedLogbookQueryKey(boardName: BoardName) {
  return ['logbook', boardName, 'accumulated'] as const;
}

export function fetchLogbookQueryKeyPrefix(boardName: BoardName) {
  return ['logbook', boardName, 'fetch'] as const;
}

/**
 * Dynamic key for each incremental fetch batch.
 */
function fetchLogbookQueryKey(boardName: BoardName, climbUuids: ClimbUuid[]) {
  return [...fetchLogbookQueryKeyPrefix(boardName), [...climbUuids].sort().join(',')] as const;
}

/** Backward-compatible export used by tests. */
export function logbookQueryKey(boardName: BoardName, climbUuids: ClimbUuid[]) {
  return ['logbook', boardName, [...climbUuids].sort().join(',')] as const;
}

/**
 * Hook to fetch logbook entries (ticks) for specific climbs.
 *
 * Uses incremental fetching: only fetches data for UUIDs that haven't been
 * fetched yet, and merges the results into a stable accumulated React Query
 * entry. This prevents indicator flicker when new pages load in the climb
 * list, because existing logbook data is never cleared during a fetch.
 */
export function useLogbook(boardName: BoardName, climbUuids: ClimbUuid[]) {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const queryClient = useQueryClient();
  const accumulatedKey = useMemo(() => accumulatedLogbookQueryKey(boardName), [boardName]);
  const fetchedUuidsRef = useRef<Set<string>>(new Set());
  const [invalidationCount, setInvalidationCount] = useState(0);

  const isEnabled = sessionStatus === 'authenticated' && !!token;
  // Signed-out → hydrate from local IndexedDB. Token isn't required for local mode.
  const isLocalMode = sessionStatus === 'unauthenticated';

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

      if (uuidsToFetch.length === 0) return [];

      const client = createGraphQLHttpClient(token);
      const variables: GetTicksQueryVariables = {
        input: {
          boardType: boardName,
          climbUuids: uuidsToFetch,
        },
      };
      const response = await client.request<GetTicksQueryResponse>(GET_TICKS, variables);
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

  // Reset UUID tracking when the accumulated cache entry is removed.
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

  // Reset when auth is lost (e.g., user logs out) so that a different
  // user logging in doesn't see stale data. Uses removeQueries to also
  // clear fetch cache entries, ensuring re-auth triggers actual re-fetches
  // instead of returning stale cached data.
  useEffect(() => {
    if (!isEnabled) {
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      queryClient.removeQueries({ queryKey: ['logbook', boardName] });
    }
  }, [isEnabled, boardName, queryClient]);

  // Hydrate the accumulated cache from IndexedDB whenever we're in local mode.
  // Runs after the reset above so it survives the logout-clear and re-runs if
  // the cache subscription bumps invalidationCount. Subsequent local saves are
  // merged optimistically via useSaveTick.onMutate, so this is one-shot per
  // session-status transition.
  useEffect(() => {
    if (!isLocalMode) return;
    let cancelled = false;
    void (async () => {
      const localTicks = await listAllLocalTicks();
      if (cancelled) return;
      const forBoard = localTicks.filter((tick) => tick.boardName === boardName);
      if (forBoard.length === 0) return;
      const entries = forBoard.map(localTickToLogbookEntry);
      queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) =>
        mergeLogbookEntries(existing, entries),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [isLocalMode, accumulatedKey, queryClient, invalidationCount, boardName]);

  return {
    logbook,
    isLoading: fetchQuery.isLoading && logbook.length === 0,
    error: fetchQuery.error,
  };
}

/**
 * Returns a function to invalidate logbook queries for a given board.
 * Removes all logbook queries from the cache, which triggers the cache
 * subscription in useLogbook to reset fetchedUuidsRef and re-fetch.
 */
export function useInvalidateLogbook(boardName: BoardName) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.removeQueries({ queryKey: ['logbook', boardName] });
  }, [queryClient, boardName]);
}
