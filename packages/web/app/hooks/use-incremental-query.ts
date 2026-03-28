'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';

const DEFAULT_CHUNK_SIZE = 500;

interface UseIncrementalQueryOptions<T> {
  /** Stable cache key for accumulated results (no UUIDs in key). Values must be primitives. */
  accumulatedKey: readonly unknown[];
  /** Prefix for dynamic fetch keys — UUIDs are appended automatically. Values must be primitives. */
  fetchKeyPrefix: readonly unknown[];
  /** Whether the query is enabled (auth check, etc.) */
  enabled: boolean;
  /** Max items per request chunk (default 500, matches server validation limit) */
  chunkSize?: number;
  /** Fetches data for a chunk of UUIDs, returns the raw result */
  fetchChunk: (uuids: string[]) => Promise<T>;
  /** Merges new fetch result into accumulated state, returns new accumulated state */
  merge: (accumulated: T, fetched: T) => T;
  /** Empty/initial value for T */
  initialValue: T;
  /**
   * Size-based comparison to detect whether merge produced new data.
   * Intentionally compares sizes rather than deep equality for performance —
   * merge always grows the collection, so a size change is a reliable signal.
   */
  hasChanged: (prev: T, next: T) => boolean;
}

interface UseIncrementalQueryResult<T> {
  data: T;
  isLoading: boolean;
  /** The error from the most recent failed fetch, or null if the last fetch succeeded. */
  error: Error | null;
  /**
   * Cancel all in-flight fetch queries for this incremental query.
   * Useful for optimistic mutations that need to prevent stale fetch results
   * from overwriting the optimistic state.
   */
  cancelFetches: () => Promise<void>;
}

function chunkArray<U>(arr: U[], size: number): U[][] {
  const chunks: U[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Generic incremental fetch hook.
 *
 * Tracks which UUIDs have already been fetched, only fetches new ones,
 * chunks large requests to respect server limits, and accumulates results
 * in local state + a stable React Query cache entry.
 *
 * Follows the proven pattern from useLogbook (packages/web/app/hooks/use-logbook.ts).
 * Compatible with optimistic updates via cache subscription.
 */
export function useIncrementalQuery<T>(
  uuids: string[],
  options: UseIncrementalQueryOptions<T>,
): UseIncrementalQueryResult<T> {
  const {
    accumulatedKey,
    fetchKeyPrefix,
    enabled,
    chunkSize = DEFAULT_CHUNK_SIZE,
    fetchChunk,
    merge,
    initialValue,
    hasChanged,
  } = options;

  const queryClient = useQueryClient();
  const fetchedUuidsRef = useRef<Set<string>>(new Set());
  const [invalidationCount, setInvalidationCount] = useState(0);

  // Track key identity changes so we can reset fetched UUIDs when context
  // changes (e.g., boardName or angle changes but the same UUID list is passed).
  // Uses a state counter instead of render-time ref mutation to be safe under
  // React concurrent mode (discarded renders won't leave stale refs).
  const currentKeyStr = useMemo(() => JSON.stringify(accumulatedKey), [accumulatedKey]);
  const prevKeyRef = useRef<string>(currentKeyStr);
  const [keyChangeCount, setKeyChangeCount] = useState(0);

  useEffect(() => {
    if (prevKeyRef.current !== currentKeyStr) {
      prevKeyRef.current = currentKeyStr;
      // Key identity changed — reset all tracking so UUIDs are re-fetched
      // for the new context. Bumping keyChangeCount triggers newUuids
      // recomputation via useMemo dependency.
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      lastCacheWriteRef.current = undefined;
      setAccumulated(initialValue);
      setKeyChangeCount((c) => c + 1);
    }
  }, [currentKeyStr, initialValue]);

  // Determine which UUIDs haven't been fetched yet.
  // invalidationCount forces recomputation after cache invalidation clears
  // fetchedUuidsRef, since uuids/enabled may not have changed.
  // keyChangeCount forces recomputation after context key changes.
  const newUuids = useMemo(
    () => (enabled ? uuids.filter((uuid) => !fetchedUuidsRef.current.has(uuid)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uuids, enabled, invalidationCount, keyChangeCount],
  );

  // Dynamic fetch key includes only the new UUIDs
  const fetchKey = useMemo(
    () => [...fetchKeyPrefix, [...newUuids].sort().join(',')] as const,
    [fetchKeyPrefix, newUuids],
  );

  // Fetch only the new UUIDs, chunking if necessary
  const fetchQuery = useQuery({
    queryKey: fetchKey,
    queryFn: async ({ queryKey }: { queryKey: readonly unknown[] }): Promise<T> => {
      // Extract UUIDs from query key to avoid stale closure issues
      const uuidsString = queryKey[queryKey.length - 1] as string;
      const uuidsToFetch = uuidsString ? uuidsString.split(',') : [];

      if (uuidsToFetch.length === 0) return initialValue;

      const chunks = chunkArray(uuidsToFetch, chunkSize);

      if (chunks.length === 1) {
        return fetchChunk(chunks[0]);
      }

      // Parallel fetch for multiple chunks — use allSettled to save partial results
      const settled = await Promise.allSettled(chunks.map((chunk) => fetchChunk(chunk)));
      const fulfilled: T[] = [];
      let failCount = 0;
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          fulfilled.push(result.value as T);
        } else {
          failCount++;
        }
      }
      if (fulfilled.length === 0) {
        // All chunks failed — rethrow the first error
        const firstRejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        throw firstRejected?.reason ?? new Error('All fetch chunks failed');
      }
      if (failCount > 0) {
        console.warn(
          `[useIncrementalQuery] ${failCount}/${settled.length} chunks failed, using partial results`,
        );
      }
      return fulfilled.reduce((acc, result) => merge(acc, result), initialValue);
    },
    enabled: enabled && newUuids.length > 0,
    // Each batch is fetched once; accumulation handles deduplication
    staleTime: Infinity,
  });

  // Cancel all in-flight fetch queries — exposed for optimistic mutations
  // to prevent stale fetch responses from overwriting optimistic state.
  const cancelFetches = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: fetchKeyPrefix });
    await queryClient.cancelQueries({ queryKey: accumulatedKey });
  }, [queryClient, fetchKeyPrefix, accumulatedKey]);

  // Accumulated state — direct useState for guaranteed re-renders
  const [accumulated, setAccumulated] = useState<T>(initialValue);

  // Reset accumulated state when key identity changes (deferred cleanup for
  // cache entries; the synchronous reset above handles fetchedUuidsRef).
  useEffect(() => {
    // On mount this runs once; on key change it clears old cache entries.
    return () => {
      // Cleanup old cache when key identity changes or component unmounts
      queryClient.removeQueries({ queryKey: fetchKeyPrefix });
      queryClient.removeQueries({ queryKey: accumulatedKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKeyStr]);

  // When fetch completes, merge new entries into state and cache.
  // IMPORTANT: Mark UUIDs as fetched here (not in queryFn) so the query key
  // remains stable until the data is consumed. If we mutated the ref inside
  // queryFn, useMemo would recompute newUuids on the re-render triggered by
  // the resolved query, changing the query key before the data could be read.
  const lastMergedRef = useRef<T | undefined>(undefined);
  // Tracks the value we last wrote to the cache ourselves, so the subscription
  // can skip the self-triggered 'updated' event (avoids redundant setAccumulated calls).
  const lastCacheWriteRef = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (!fetchQuery.data || fetchQuery.data === lastMergedRef.current) return;

    // Guard against stale fetch results from a previous context (e.g., board/angle changed mid-fetch).
    // If the key has changed since this fetch started, discard the results.
    if (prevKeyRef.current !== currentKeyStr) return;

    lastMergedRef.current = fetchQuery.data;

    // Mark these UUIDs as fetched (including those with no results)
    newUuids.forEach((uuid) => fetchedUuidsRef.current.add(uuid));

    const merged = merge(accumulated, fetchQuery.data);
    if (hasChanged(accumulated, merged)) {
      setAccumulated(merged);
      lastCacheWriteRef.current = merged;
      queryClient.setQueryData(accumulatedKey, merged);
    }
  }, [fetchQuery.data, newUuids, accumulated, merge, hasChanged, accumulatedKey, queryClient, currentKeyStr]);

  // Subscribe to cache changes for the accumulated key only.
  // Handles two scenarios:
  // 1. Optimistic updates (setQueriesData modifies the cache externally)
  // 2. Cache invalidation (removeQueries) — resets fetchedUuidsRef so all
  //    UUIDs are re-fetched on the next render.
  useEffect(() => {
    const key = accumulatedKey;

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // Only react to events for our accumulated key.
      // Uses reference equality (===) — keys must contain only primitives (strings, numbers).
      const qk = event.query.queryKey;
      if (qk.length !== key.length || qk.some((v: unknown, i: number) => v !== key[i])) return;

      if (event.type === 'removed') {
        // Cache was cleared — reset tracking so all current UUIDs are re-fetched
        fetchedUuidsRef.current = new Set();
        lastMergedRef.current = undefined;
        lastCacheWriteRef.current = undefined;
        setAccumulated(initialValue);
        setInvalidationCount((c) => c + 1);
      } else if (event.type === 'updated') {
        const cached = queryClient.getQueryData<T>(key);
        if (cached !== undefined) {
          // Skip the self-triggered event from our own merge effect (same reference
          // we just wrote), but clear the ref so subsequent writes are not filtered.
          if (cached === lastCacheWriteRef.current) {
            lastCacheWriteRef.current = undefined;
            return;
          }
          setAccumulated(cached);
        }
      }
    });
    return unsubscribe;
  }, [queryClient, accumulatedKey, initialValue]);

  // Reset when disabled (e.g., user logs out) so a different user logging in
  // doesn't see stale data. Uses removeQueries to also clear fetch cache entries.
  useEffect(() => {
    if (!enabled) {
      fetchedUuidsRef.current = new Set();
      lastMergedRef.current = undefined;
      lastCacheWriteRef.current = undefined;
      setAccumulated(initialValue);
      queryClient.removeQueries({ queryKey: fetchKeyPrefix });
      queryClient.removeQueries({ queryKey: accumulatedKey });
    }
  }, [enabled, fetchKeyPrefix, accumulatedKey, initialValue, queryClient]);

  return {
    data: accumulated,
    isLoading: fetchQuery.isLoading && !hasChanged(initialValue, accumulated),
    error: fetchQuery.error instanceof Error ? fetchQuery.error : fetchQuery.error ? new Error(String(fetchQuery.error)) : null,
    cancelFetches,
  };
}
