import { getHoldHeatmapData as getSharedHoldHeatmapData, type HoldHeatmapData } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';

export type { HoldHeatmapData };

export async function getHoldHeatmapData(
  params: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
  userId?: string,
): Promise<HoldHeatmapData[]> {
  return getSharedHoldHeatmapData(dbzRead, params, searchParams, userId);
}
