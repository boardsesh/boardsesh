'use client';

import React, { createContext, useContext, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_BULK_VOTE_SUMMARIES,
  type GetBulkVoteSummariesQueryVariables,
  type GetBulkVoteSummariesQueryResponse,
} from '@boardsesh/graphql/operations';
import { batchVoteSummaryEntityIds, type SocialEntityType, type VoteSummary } from '@boardsesh/shared-schema';

/**
 * Merges the per-chunk results into one summary list.
 *
 * Passing this to `useQueries` as `combine` is what keeps the merged list
 * referentially stable. Without a `combine`, `useQueries` hands back a freshly
 * mapped array on every render, which would rebuild `summariesMap` and re-mint
 * the context value on every provider render — re-rendering every VoteButton
 * beneath a provider that can wrap 100+ of them. With `combine`, react-query
 * runs the merge through `replaceEqualDeep` and hands back the previous value
 * when no vote changed.
 *
 * Declared at module scope so its identity never changes: react-query re-runs
 * `combine` whenever the function itself does.
 */
function combineVoteSummaryChunks(results: { data: VoteSummary[] | undefined }[]): VoteSummary[] {
  return results.flatMap((result) => result.data ?? []);
}

type VoteSummaryContextValue = {
  getVoteSummary: (entityId: string) => VoteSummary | undefined;
};

const VoteSummaryContext = createContext<VoteSummaryContextValue | null>(null);

/**
 * Returns batch-fetched vote summary data when inside a VoteSummaryProvider,
 * or null when outside one. VoteButton uses this to avoid N+1 requests.
 */
export function useVoteSummaryContext(): VoteSummaryContextValue | null {
  return useContext(VoteSummaryContext);
}

type VoteSummaryProviderProps = {
  entityType: SocialEntityType;
  entityIds: string[];
  children: React.ReactNode;
};

/**
 * Batch-fetches vote summaries (including userVote) for a list of entities
 * via GET_BULK_VOTE_SUMMARIES and provides them via context. Wrap groups of
 * VoteButtons with this provider to avoid N+1 individual requests.
 *
 * Chunks internally so callers never need to slice their entityIds list
 * before handing it here — a caller-side cap used to silently drop rows
 * past 100 to a `0` vote display instead of fetching their real count.
 * If one chunk's request fails, the rows it covered simply stay
 * unhydrated (VoteButton falls back to its own single-entity fetch);
 * chunks that did resolve still populate the map.
 */
export function VoteSummaryProvider({ entityType, entityIds, children }: VoteSummaryProviderProps) {
  const { token, isAuthenticated, isLoading: isAuthLoading } = useWsAuthToken();

  const chunks = useMemo(() => batchVoteSummaryEntityIds(entityIds), [entityIds]);

  const summaries = useQueries({
    queries: chunks.map((chunk) => {
      // Sorted so the key is order-independent *within* a chunk; each chunk
      // caches independently under its own (entityType, sortedChunkIds) key.
      // Chunk boundaries still follow the caller's order, which is what keeps
      // an append-only feed's earlier chunks cached as it pages.
      const sortedIds = [...chunk].sort();
      return {
        queryKey: ['bulkVoteSummaries', entityType, sortedIds.join(',')] as const,
        queryFn: async (): Promise<VoteSummary[]> => {
          const client = createGraphQLHttpClient(token);
          const response = await client.request<GetBulkVoteSummariesQueryResponse, GetBulkVoteSummariesQueryVariables>(
            GET_BULK_VOTE_SUMMARIES,
            {
              input: { entityType, entityIds: sortedIds },
            },
          );
          return response.bulkVoteSummaries;
        },
        enabled: isAuthenticated && !isAuthLoading && !!token,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      };
    }),
    combine: combineVoteSummaryChunks,
  });

  const summariesMap = useMemo(() => {
    const map = new Map<string, VoteSummary>();
    for (const summary of summaries) {
      map.set(summary.entityId, summary);
    }
    return map;
  }, [summaries]);

  const value = useMemo<VoteSummaryContextValue>(
    () => ({
      getVoteSummary: (entityId: string) => summariesMap.get(entityId),
    }),
    [summariesMap],
  );

  return <VoteSummaryContext.Provider value={value}>{children}</VoteSummaryContext.Provider>;
}
