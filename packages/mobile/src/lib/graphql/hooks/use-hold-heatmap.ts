import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoardName, HoldStat } from '@boardsesh/shared-schema';
import { HOLD_HEATMAP_QUERY, type HoldHeatmapResponse } from '@boardsesh/graphql/operations';
import { getHttpClient } from '../client';

/** Board configuration the heatmap aggregates over (matches HoldHeatmapInput). */
export type HoldHeatmapParams = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type UseHoldHeatmapResult = {
  holdStats: HoldStat[];
  /** Lookup from hold id → its aggregate row, for O(1) access while rendering. */
  statsByHoldId: Map<number, HoldStat>;
  isLoading: boolean;
  /** True when the heatmap query failed; lets the screen drop the overlay + warn. */
  isError: boolean;
};

/**
 * Community hold-usage heatmap for a board configuration. Community totals only
 * — never sends a userId. Stays disabled until `enabled` flips (the create
 * editor only fetches once the user toggles the heatmap on). Cached 5 minutes
 * since the aggregate barely moves.
 */
export function useHoldHeatmap(params: HoldHeatmapParams, enabled: boolean): UseHoldHeatmapResult {
  const query = useQuery({
    queryKey: ['holdHeatmap', params.boardName, params.layoutId, params.sizeId, params.setIds, params.angle],
    queryFn: () =>
      getHttpClient().request<HoldHeatmapResponse>(HOLD_HEATMAP_QUERY, {
        input: {
          boardName: params.boardName,
          layoutId: params.layoutId,
          sizeId: params.sizeId,
          setIds: params.setIds,
          angle: params.angle,
        },
      }),
    select: (data) => data.holdHeatmap,
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const holdStats = useMemo(() => query.data ?? [], [query.data]);
  const statsByHoldId = useMemo(() => {
    const map = new Map<number, HoldStat>();
    for (const stat of holdStats) map.set(stat.holdId, stat);
    return map;
  }, [holdStats]);

  return { holdStats, statsByHoldId, isLoading: query.isLoading, isError: query.isError };
}
