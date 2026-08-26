import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { SearchRequestPagination } from '@/app/lib/types';
import { resolveBoardBySlug, boardToRouteParamsFromAngleSegment } from '@/app/lib/board-slug-utils';
import StaticListFrontDoor from '@/app/components/climb-front-door/static-list-front-door';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { fetchFrontDoorListPage } from '@/app/lib/data/list-page-data.server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import {
  isFrontDoorPageOutOfRange,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
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
    if (!board) {
      return createPageMetadata({
        title: t('metadata.list.fallbackTitle'),
        description: t('metadata.list.fallbackDescription'),
        locale,
      });
    }

    const boardName = formatBoardDisplayName(board.boardType);
    const parsedParams = boardToRouteParamsFromAngleSegment(board, params.angle);
    if (!parsedParams) {
      return createPageMetadata({
        title: t('metadata.list.fallbackTitle'),
        description: t('metadata.list.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }
    const angle = parsedParams.angle;
    const page = parseFrontDoorPage(searchParams.page);

    // A1: canonicalise into the config-tuple tree via the same builder that
    // tree's own `/list` page calls, so one board config emits one canonical.
    // `resolveListPageIndexation` then applies the SAME filter/pagination
    // doctrine both trees use — see its docblock for why a hidden board is the
    // one case that emits no canonical at all.
    //
    // Unlisted is link-only by design, and a private board is readable to a
    // slug holder until #4087 masks it — neither belongs in the index. This is
    // indexation only; it is not the access control, which #4087 owns.
    const { path, robots } = resolveListPageIndexation({
      cleanPath: buildCanonicalClimbListUrl(getBoardDetailsForBoard(parsedParams), angle),
      page,
      searchParams: searchParams as unknown as ListPageSearchParams,
      boardIsHidden: board.isUnlisted || !board.isPublic,
    });

    return createPageMetadata({
      title:
        page > 1
          ? t('metadata.list.paginatedTitle', { boardName, angle: params.angle, page })
          : t('metadata.list.title', { boardName, angle: params.angle }),
      description: t('metadata.list.description', { boardName, angle: params.angle }),
      path,
      locale,
      robots,
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

  // Same ceiling as the config-tuple twin: nothing links past
  // `FRONT_DOOR_MAX_INDEXABLE_PAGE`, so a page number beyond the grace band is a
  // guess and gets a 404 rather than a deep `OFFSET`.
  if (isFrontDoorPageOutOfRange(searchParams.page)) return notFound();

  const parsedParams = boardToRouteParamsFromAngleSegment(board, params.angle);
  if (!parsedParams) return notFound();
  const page = parseFrontDoorPage(searchParams.page);
  const listData = await fetchFrontDoorListPage(parsedParams, page);
  if (!listData) return notFound();
  const { boardDetails, climbs, hasMore, preloadUrls } = listData;

  return (
    <>
      {preloadUrls.map((preloadUrl) => (
        <link key={preloadUrl} rel="preload" as="image" href={preloadUrl} fetchPriority="high" />
      ))}
      <StaticListFrontDoor
        boardDetails={boardDetails}
        angle={parsedParams.angle}
        climbs={climbs}
        hasMore={hasMore}
        page={page}
        // Pagination and the CTA stay on the `/b` pathname the reader is on —
        // the canonical points at the config-tuple tree, the navigation does
        // not move them off the board they arrived through.
        basePath={`/b/${params.board_slug}/${params.angle}/list`}
        tree="slug"
      />
    </>
  );
}
