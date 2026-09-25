import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClimbSearchInput, HoldStat } from '@boardsesh/shared-schema';
import {
  HOLD_HEATMAP_QUERY,
  type HoldHeatmapQueryResponse,
  type HoldHeatmapQueryVariables,
} from '@boardsesh/graphql/operations';
import type { CatalogQuerySource } from '../../offline/use-catalog-query-source';
import { getHttpClient } from '../client';
import { offlineAwareRequest } from '../offline-request';

const HOLD_HEATMAP_STALE_TIME_MS = 5 * 60 * 1000;
const EMPTY_STATS: HoldStat[] = [];

/**
 * Per-hold usage over the climbs `input` matches, for the heatmap overlay.
 *
 * `source` comes from `useCatalogQuerySource` for the input's board scope:
 * - `local` — the downloaded board answers through `offlineAwareRequest`, where
 *   the op is registered local-only (it never reaches the network from there);
 * - `network` — an admin on a board that is not downloaded asks the admin-gated
 *   resolver directly;
 * - `download` — nothing runs; the caller shows the download offer.
 *
 * The source is part of the key so an admin's network answer and the local one
 * never share a cache entry.
 */
export function useHoldHeatmap(input: ClimbSearchInput, source: CatalogQuerySource, enabled: boolean) {
  const query = useQuery({
    queryKey: ['holdHeatmap', source, input],
    queryFn: () => {
      const variables: HoldHeatmapQueryVariables = { input };
      return source === 'local'
        ? offlineAwareRequest<HoldHeatmapQueryResponse>(HOLD_HEATMAP_QUERY, variables)
        : getHttpClient().request<HoldHeatmapQueryResponse, HoldHeatmapQueryVariables>(HOLD_HEATMAP_QUERY, variables);
    },
    select: (response) => response.holdHeatmap,
    enabled: enabled && source !== 'download',
    staleTime: HOLD_HEATMAP_STALE_TIME_MS,
    retry: false,
  });

  const holdStats = query.data ?? EMPTY_STATS;
  const statsByHoldId = useMemo(() => {
    const stats = new Map<number, HoldStat>();
    for (const holdStat of holdStats) stats.set(holdStat.holdId, holdStat);
    return stats;
  }, [holdStats]);

  return {
    holdStats,
    statsByHoldId,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    isError: query.isError,
    errorUpdatedAt: query.errorUpdatedAt,
  };
}
