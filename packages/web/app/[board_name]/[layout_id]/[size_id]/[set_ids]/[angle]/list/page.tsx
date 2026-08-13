import React from 'react';

import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { BoardRouteParameters, BoardRouteParametersWithUuid, SearchRequestPagination } from '@/app/lib/types';
import { constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import BoardPageClimbsList from '@/app/components/board-page/board-page-climbs-list';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { fetchListPageData } from '@/app/lib/data/list-page-data.server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { hasListFilterParams, type ListPageSearchParams } from '@/app/lib/seo/list-page-robots';
import { getServerTranslation } from '@/app/lib/i18n/server';

export async function generateMetadata(props: {
  params: Promise<BoardRouteParameters>;
  searchParams: Promise<SearchRequestPagination>;
}): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  // Filter/sort query params are an unbounded crawl space over the same page of
  // content: keep them out of the index, point them at the clean base URL, and
  // let crawlers follow links off the page.
  //
  // An unfiltered request is left alone deliberately. Giving this legacy tree
  // its own canonical would put a second self-canonicalising URL on the same
  // climb list that `/b/{slug}/{angle}/list` already claims — the PageRank
  // split `climb-canonical-parity.test.ts` exists to stop widening.
  if (!hasListFilterParams(searchParams as unknown as ListPageSearchParams)) {
    return {};
  }

  const { t, locale } = await getServerTranslation('climbs');
  const boardName = formatBoardDisplayName(params.board_name);
  const cleanPath = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/list`;

  return createNoIndexMetadata({
    title: t('metadata.list.title', { boardName, angle: params.angle }),
    description: t('metadata.list.description', { boardName, angle: params.angle }),
    path: cleanPath,
    locale,
  });
}

export default async function DynamicResultsPage(props: {
  params: Promise<BoardRouteParametersWithUuid>;
  searchParams: Promise<SearchRequestPagination>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { parsedParams, isNumericFormat } = await parseRouteParams(params);

  // Redirect old numeric URLs to new slug format
  if (isNumericFormat) {
    const boardDetails = getBoardDetailsForBoard(parsedParams);

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      // Id-aware first: the name-based builder can only emit the bare size slug,
      // so a numeric URL for a size that shares one with another on the same
      // layout (Kilter layout 1 sizes 10/27) would 308 — permanently, from the
      // browser cache — onto the other board. Names stay as the fallback for a
      // board the static tables don't carry.
      const newUrl =
        tryConstructSlugListUrl(
          parsedParams.board_name,
          parsedParams.layout_id,
          parsedParams.size_id,
          parsedParams.set_ids,
          parsedParams.angle,
        ) ??
        constructClimbListWithSlugs(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          parsedParams.angle,
        );

      // Preserve search parameters
      const searchString = new URLSearchParams(
        Object.entries(searchParams).reduce(
          (acc, [key, value]) => {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              acc[key] = String(value);
            } else if (Array.isArray(value)) {
              acc[key] = value.join(',');
            }
            return acc;
          },
          {} as Record<string, string>,
        ),
      ).toString();
      const finalUrl = searchString ? `${newUrl}?${searchString}` : newUrl;

      permanentRedirect(finalUrl);
    }
  }

  const listData = await fetchListPageData(parsedParams, searchParams);
  if (!listData) return notFound();
  const { boardDetails, searchResponse, preloadUrl } = listData;

  return (
    <>
      {preloadUrl && <link rel="preload" as="image" href={preloadUrl} fetchPriority="high" />}
      <BoardPageClimbsList
        {...parsedParams}
        boardDetails={boardDetails}
        initialClimbs={searchResponse.climbs}
        initialHasMore={searchResponse.hasMore}
      />
    </>
  );
}
