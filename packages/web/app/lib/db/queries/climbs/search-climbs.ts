import 'server-only';
import { unstable_cache } from 'next/cache';
import { getDb } from '@/app/lib/db/db';
import { searchClimbs as sharedSearchClimbs, type ClimbSearchResult } from '@boardsesh/db/queries';
import { getSizeEdges } from '@/app/lib/__generated__/product-sizes-data';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import type { Climb } from '@/app/lib/types';
import { sortObjectKeys } from '@/app/lib/cache-utils';

/**
 * Cache durations for climb search queries (in seconds)
 */
const CACHE_DURATION_DEFAULT_SEARCH = 24 * 60 * 60; // 24 hours for default searches
const CACHE_DURATION_FILTERED_SEARCH = 60 * 60; // 1 hour for filtered searches

/**
 * Search for climbs directly from the database (no GraphQL round-trip).
 * Used by SSR page components for faster initial page loads.
 *
 * @param params Board route parameters
 * @param searchParams Search/filter parameters from URL
 * @param isDefaultSearch Whether this is a default/unfiltered search (caches longer)
 * @param userId Optional user ID for personal progress filters
 */
export async function cachedSearchClimbs(
  params: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
  isDefaultSearch: boolean,
  userId?: string,
  options?: { cacheable?: boolean },
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  const cacheable = options?.cacheable ?? !userId;

  const revalidate = isDefaultSearch
    ? CACHE_DURATION_DEFAULT_SEARCH
    : CACHE_DURATION_FILTERED_SEARCH;

  const executeQuery = async () => {
    const sizeEdges = getSizeEdges(params.board_name, params.size_id);
    if (!sizeEdges) {
      return { climbs: [], hasMore: false };
    }

    const db = getDb();
    const result = await sharedSearchClimbs(db, params, {
      page: searchParams.page,
      pageSize: searchParams.pageSize,
      gradeAccuracy: searchParams.gradeAccuracy ? Number(searchParams.gradeAccuracy) : undefined,
      minGrade: searchParams.minGrade || undefined,
      maxGrade: searchParams.maxGrade || undefined,
      minAscents: searchParams.minAscents || undefined,
      minRating: searchParams.minRating || undefined,
      sortBy: searchParams.sortBy || 'ascents',
      sortOrder: searchParams.sortOrder || 'desc',
      name: searchParams.name || undefined,
      settername: searchParams.settername && searchParams.settername.length > 0 ? searchParams.settername : undefined,
      onlyTallClimbs: searchParams.onlyTallClimbs || undefined,
      holdsFilter: searchParams.holdsFilter && Object.keys(searchParams.holdsFilter).length > 0
        ? Object.fromEntries(
            Object.entries(searchParams.holdsFilter).map(([key, value]) => [
              key.replace('hold_', ''),
              typeof value === 'object' && value !== null ? (value as { state: string }).state : value,
            ])
          )
        : undefined,
      hideAttempted: searchParams.hideAttempted || undefined,
      hideCompleted: searchParams.hideCompleted || undefined,
      showOnlyAttempted: searchParams.showOnlyAttempted || undefined,
      showOnlyCompleted: searchParams.showOnlyCompleted || undefined,
      onlyDrafts: searchParams.onlyDrafts || undefined,
    }, sizeEdges, userId);

    // Map ClimbRow to the web Climb type
    const climbs: Climb[] = result.climbs.map((row) => ({
      ...row,
      mirrored: undefined,
    }));

    return { climbs, hasMore: result.hasMore };
  };

  if (!cacheable) {
    return executeQuery();
  }

  const cacheKey = [
    'climb-search-direct',
    params.board_name,
    String(params.layout_id),
    String(params.size_id),
    params.set_ids.join(','),
    String(params.angle),
    JSON.stringify(sortObjectKeys({
      page: searchParams.page,
      pageSize: searchParams.pageSize,
      gradeAccuracy: searchParams.gradeAccuracy,
      minGrade: searchParams.minGrade,
      maxGrade: searchParams.maxGrade,
      minAscents: searchParams.minAscents,
      minRating: searchParams.minRating,
      sortBy: searchParams.sortBy,
      sortOrder: searchParams.sortOrder,
      name: searchParams.name,
      setter: searchParams.settername,
      onlyTallClimbs: searchParams.onlyTallClimbs,
      holdsFilter: searchParams.holdsFilter,
      hideAttempted: searchParams.hideAttempted,
      hideCompleted: searchParams.hideCompleted,
      showOnlyAttempted: searchParams.showOnlyAttempted,
      showOnlyCompleted: searchParams.showOnlyCompleted,
      onlyDrafts: searchParams.onlyDrafts,
    })),
  ];

  const cachedFn = unstable_cache(
    executeQuery,
    cacheKey,
    {
      revalidate,
      tags: ['climb-search'],
    },
  );

  return cachedFn();
}
