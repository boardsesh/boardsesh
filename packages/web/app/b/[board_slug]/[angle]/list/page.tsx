import React from 'react';
import { notFound } from 'next/navigation';
import { SearchRequestPagination, BoardDetails } from '@/app/lib/types';
import { parsedRouteSearchParamsToSearchParams } from '@/app/lib/url-utils';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import BoardPageClimbsList from '@/app/components/board-page/board-page-climbs-list';
import { SSRInitialClimbsProvider } from '@/app/components/queue-control/ssr-initial-climbs-context';
import { cachedSearchClimbs } from '@/app/lib/graphql/server-cached-client';
import { SEARCH_CLIMBS, type ClimbSearchResponse } from '@/app/lib/graphql/operations/climb-search';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { MAX_PAGE_SIZE } from '@/app/components/board-page/constants';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';

interface BoardSlugListPageProps {
  params: Promise<{ board_slug: string; angle: string }>;
  searchParams: Promise<SearchRequestPagination>;
}

export default async function BoardSlugListPage(props: BoardSlugListPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const parsedParams = boardToRouteParams(board, Number(params.angle));
  const searchParamsObject: SearchRequestPagination = parsedRouteSearchParamsToSearchParams(searchParams);

  const requestedPageSize = (Number(searchParamsObject.page) + 1) * Number(searchParamsObject.pageSize);
  searchParamsObject.pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  searchParamsObject.page = 0;

  // Personal progress filters require auth which SSR doesn't have.
  // Include them in the input so the cache key differentiates filtered vs unfiltered results,
  // but skip the server cache entirely when they're active.
  const hasProgressFilters = !!(
    searchParamsObject.hideAttempted ||
    searchParamsObject.hideCompleted ||
    searchParamsObject.showOnlyAttempted ||
    searchParamsObject.showOnlyCompleted
  );

  const searchInput = {
    boardName: parsedParams.board_name,
    layoutId: parsedParams.layout_id,
    sizeId: parsedParams.size_id,
    setIds: parsedParams.set_ids.join(','),
    angle: parsedParams.angle,
    page: searchParamsObject.page,
    pageSize: searchParamsObject.pageSize,
    gradeAccuracy: searchParamsObject.gradeAccuracy ? String(searchParamsObject.gradeAccuracy) : undefined,
    minGrade: searchParamsObject.minGrade || undefined,
    maxGrade: searchParamsObject.maxGrade || undefined,
    minAscents: searchParamsObject.minAscents || undefined,
    sortBy: searchParamsObject.sortBy || 'ascents',
    sortOrder: searchParamsObject.sortOrder || 'desc',
    name: searchParamsObject.name || undefined,
    setter: searchParamsObject.settername && searchParamsObject.settername.length > 0 ? searchParamsObject.settername : undefined,
    onlyTallClimbs: searchParamsObject.onlyTallClimbs || undefined,
    holdsFilter: searchParamsObject.holdsFilter && Object.keys(searchParamsObject.holdsFilter).length > 0
      ? Object.fromEntries(
          Object.entries(searchParamsObject.holdsFilter).map(([key, value]) => [
            key.replace('hold_', ''),
            value.state
          ])
        )
      : undefined,
    hideAttempted: searchParamsObject.hideAttempted || undefined,
    hideCompleted: searchParamsObject.hideCompleted || undefined,
    showOnlyAttempted: searchParamsObject.showOnlyAttempted || undefined,
    showOnlyCompleted: searchParamsObject.showOnlyCompleted || undefined,
  };

  const isDefaultSearch =
    !searchParamsObject.gradeAccuracy &&
    !searchParamsObject.minGrade &&
    !searchParamsObject.maxGrade &&
    !searchParamsObject.minAscents &&
    !searchParamsObject.name &&
    (!searchParamsObject.settername || searchParamsObject.settername.length === 0) &&
    (searchParamsObject.sortBy || 'ascents') === 'ascents' &&
    (searchParamsObject.sortOrder || 'desc') === 'desc' &&
    !searchParamsObject.onlyTallClimbs &&
    (!searchParamsObject.holdsFilter || Object.keys(searchParamsObject.holdsFilter).length === 0) &&
    !hasProgressFilters;

  let searchResponse: ClimbSearchResponse;
  let boardDetails: BoardDetails;

  try {
    boardDetails = getBoardDetailsForBoard(parsedParams);
  } catch {
    return notFound();
  }

  // When progress filters are active, fetch with auth so the backend can apply
  // per-user NOT EXISTS/EXISTS filters. The auth token is included in the cache key
  // so each user gets their own cached result.
  const authToken = hasProgressFilters ? await getServerAuthToken() : undefined;

  try {
    searchResponse = await cachedSearchClimbs<ClimbSearchResponse>(
      SEARCH_CLIMBS,
      { input: searchInput },
      isDefaultSearch,
      authToken,
    );
  } catch (error) {
    console.error('Error fetching climb search results:', error);
    searchResponse = { searchClimbs: { climbs: [], hasMore: false } };
  }

  return (
    <SSRInitialClimbsProvider initialClimbs={searchResponse.searchClimbs.climbs} hasMore={searchResponse.searchClimbs.hasMore}>
      <BoardPageClimbsList {...parsedParams} boardDetails={boardDetails} initialClimbs={searchResponse.searchClimbs.climbs} />
    </SSRInitialClimbsProvider>
  );
}
