import React from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { SearchRequestPagination } from '@/app/lib/types';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import BoardPageListView from '@/app/components/board-page/board-page-list-view';
import { fetchClimbPageData } from '@/app/components/board-page/fetch-climb-page-data';
import { formatBoardDisplayName } from '@/app/lib/string-utils';

interface BoardSlugListPageProps {
  params: Promise<{ board_slug: string; angle: string }>;
  searchParams: Promise<SearchRequestPagination>;
}

export async function generateMetadata(props: BoardSlugListPageProps): Promise<Metadata> {
  const params = await props.params;

  try {
    const board = await resolveBoardBySlug(params.board_slug);
    if (!board) {
      return { title: 'Climbs | Boardsesh', description: 'Browse climbing routes' };
    }

    const boardName = formatBoardDisplayName(board.boardType);
    const angle = params.angle;
    const title = `${boardName} Climbs at ${angle}° | Boardsesh`;
    const description = `Browse climbing routes on ${boardName} at ${angle}°`;
    const canonicalUrl = `/b/${params.board_slug}/${angle}/list`;

    return {
      title,
      description,
      alternates: { canonical: canonicalUrl },
      openGraph: {
        title,
        description,
        type: 'website',
        url: canonicalUrl,
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
      },
    };
  } catch {
    return { title: 'Climbs | Boardsesh', description: 'Browse climbing routes' };
  }
}

export default async function BoardSlugListPage(props: BoardSlugListPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const parsedParams = boardToRouteParams(board, Number(params.angle));

  const data = await fetchClimbPageData(parsedParams, searchParams);
  if (!data) return notFound();

  return (
    <>
      {data.preloadUrl && <link rel="preload" as="image" href={data.preloadUrl} fetchPriority="high" />}
      <BoardPageListView {...parsedParams} boardDetails={data.boardDetails} initialClimbs={data.climbs} />
    </>
  );
}
