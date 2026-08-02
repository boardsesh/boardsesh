import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { SearchRequestPagination } from '@/app/lib/types';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import BoardPageClimbsList from '@/app/components/board-page/board-page-climbs-list';
import { fetchListPageData } from '@/app/lib/data/list-page-data.server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { hasListFilterParams, type ListPageSearchParams } from '@/app/lib/seo/list-page-robots';
import { getServerTranslation } from '@/app/lib/i18n/server';

type BoardSlugListPageProps = {
  params: Promise<{ board_slug: string; angle: string }>;
  searchParams: Promise<SearchRequestPagination>;
};

export async function generateMetadata(props: BoardSlugListPageProps): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const { t, locale } = await getServerTranslation('climbs');

  try {
    const board = await resolveBoardBySlug(params.board_slug);
    // `boardBySlug` masks a board this viewer may not read as null, so a
    // private board's name and description never reach an anonymous crawler.
    if (!board) {
      return createPageMetadata({
        title: t('metadata.list.fallbackTitle'),
        description: t('metadata.list.fallbackDescription'),
        locale,
      });
    }

    const boardName = formatBoardDisplayName(board.boardType);
    const angle = params.angle;
    // Unlisted boards are link-only by design. A private board only resolves
    // for its owner or gym staff, never for a crawler, but keep it out of the
    // index too so a signed-in render can't seed one.
    const listShouldNoindex =
      board.isUnlisted || !board.isPublic || hasListFilterParams(searchParams as unknown as ListPageSearchParams);

    return createPageMetadata({
      title: t('metadata.list.title', { boardName, angle }),
      description: t('metadata.list.description', { boardName, angle }),
      path: `/b/${params.board_slug}/${angle}/list`,
      locale,
      robots: listShouldNoindex ? { index: false, follow: true } : undefined,
    });
  } catch {
    return createPageMetadata({
      title: t('metadata.list.fallbackTitle'),
      description: t('metadata.list.fallbackDescription'),
      locale,
    });
  }
}

export default async function BoardSlugListPage(props: BoardSlugListPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const parsedParams = boardToRouteParams(board, Number(params.angle));
  const listData = await fetchListPageData(parsedParams, searchParams as SearchRequestPagination);
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
