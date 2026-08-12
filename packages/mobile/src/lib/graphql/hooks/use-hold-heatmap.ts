import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoardName, HoldStat } from '@boardsesh/shared-schema';
import {
  HOLD_HEATMAP_QUERY,
  type HoldHeatmapQueryResponse,
  type HoldHeatmapQueryVariables,
} from '@boardsesh/graphql/operations';
import { getHttpClient } from '../client';

export type HoldHeatmapParams = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/** Community hold usage, fetched only while the create-drawer toggle is active. */
export function useHoldHeatmap(params: HoldHeatmapParams, enabled: boolean) {
  const query = useQuery({
    queryKey: ['holdHeatmap', params.boardName, params.layoutId, params.sizeId, params.setIds, params.angle],
    queryFn: () =>
      getHttpClient().request<HoldHeatmapQueryResponse, HoldHeatmapQueryVariables>(HOLD_HEATMAP_QUERY, {
        input: params,
      }),
    select: (response) => response.holdHeatmap,
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const holdStats = useMemo(() => query.data ?? [], [query.data]);
  const statsByHoldId = useMemo(() => {
    const stats = new Map<number, HoldStat>();
    for (const holdStat of holdStats) stats.set(holdStat.holdId, holdStat);
    return stats;
  }, [holdStats]);

  return {
    holdStats,
    statsByHoldId,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    errorUpdatedAt: query.errorUpdatedAt,
  };
}
