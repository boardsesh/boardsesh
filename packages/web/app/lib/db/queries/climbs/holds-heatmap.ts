import { dbzRead } from '@/app/lib/db/db';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import { type HoldHeatmapData, getHoldHeatmapData as getSharedHoldHeatmapData } from '@boardsesh/db/queries';

export type { HoldHeatmapData };

/**
 * Web wrapper over the shared `getHoldHeatmapData`. Hands the web read-replica
 * Drizzle handle (`dbzRead`) to the shared query so the REST heatmap route and
 * the anonymous cache layer keep their existing `(params, searchParams, userId?)`
 * signature unchanged.
 */
export const getHoldHeatmapData = async (
  params: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
  userId?: string,
): Promise<HoldHeatmapData[]> => {
  return getSharedHoldHeatmapData(dbzRead, params, searchParams, userId);
};
