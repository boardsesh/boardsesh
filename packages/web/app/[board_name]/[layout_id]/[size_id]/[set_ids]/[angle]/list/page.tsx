import React from 'react';

import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { BoardRouteParameters, BoardRouteParametersWithUuid, SearchRequestPagination } from '@/app/lib/types';
import { buildCanonicalClimbListUrl, constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import StaticListFrontDoor from '@/app/components/climb-front-door/static-list-front-door';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { fetchFrontDoorListPage } from '@/app/lib/data/list-page-data.server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import {
  isFrontDoorPageOutOfRange,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
import { getServerTranslation } from '@/app/lib/i18n/server';

export async function generateMetadata(props: {
  params: Promise<BoardRouteParameters>;
  searchParams: Promise<SearchRequestPagination>;
}): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  const { t, locale } = await getServerTranslation('climbs');
  const boardName = formatBoardDisplayName(params.board_name);

  try {
    // Resolve the request's slugs to ids and build the canonical from THOSE,
    // through the same builder `/b/{slug}/{angle}/list` calls. Echoing the
    // request's own segments back would hand every alias spelling of one board
    // config its own self-canonical: `kilter-original` and `original` both
    // resolve to layout 1 (the board-prefix strip in `findLayoutBySlug`),
    // `12x12` and `12x12-square` both to size 10 (the bare-dimension fallback
    // in `findSizeBySlug`), and `bolt_screw` and `screw_bolt` both to [1,20]
    // (`matchSetNameToSlugParts` is order-insensitive) — N competing claims,
    // none of them the URL `/b` now canonicalises into.
    //
    // `parseRouteParams` is React-`cache`d and the page body below calls it on
    // the same request, so this resolution is free.
    const { parsedParams } = await parseRouteParams(params);
    const angle = parsedParams.angle;
    const cleanPath = buildCanonicalClimbListUrl(getBoardDetailsForBoard(parsedParams), angle);

    // Self-canonical for the unfiltered case. This page used to return a bare
    // `{}` rather than claim one, because `/b/{slug}/{angle}/list` was also
    // self-canonicalising and a second canonical would have widened the
    // PageRank split. W-15 closes that: `/b` now canonicalises into this tree
    // (A1), so this is the one URL for the config and it should say so.
    const page = parseFrontDoorPage(searchParams.page);
    const { path, robots } = resolveListPageIndexation({
      cleanPath,
      page,
      searchParams: searchParams as unknown as ListPageSearchParams,
    });

    return createPageMetadata({
      title:
        page > 1
          ? t('metadata.list.paginatedTitle', { boardName, angle, page })
          : t('metadata.list.title', { boardName, angle }),
      description: t('metadata.list.description', { boardName, angle }),
      path,
      locale,
      robots,
    });
  } catch {
    // A board config the slug tables and the DB both fail to resolve. Claim no
    // canonical for a URL that has no board behind it. On the same request the
    // page body 404s for an unresolvable config or an out-of-range `?page`, and
    // 500s if the read itself failed (#4461) — metadata never decides that.
    return createPageMetadata({
      title: t('metadata.list.fallbackTitle'),
      description: t('metadata.list.fallbackDescription'),
      locale,
      robots: { index: false, follow: true },
    });
  }
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

  // Past the hard ceiling there is no page to render — the front door links no
  // further than `FRONT_DOOR_MAX_INDEXABLE_PAGE`, so `?page=5000` is a guess, not
  // a thin duplicate to consolidate. 404 before the query so a crawler walking
  // made-up page numbers costs one not-found, not one deep `OFFSET` each.
  if (isFrontDoorPageOutOfRange(searchParams.page)) return notFound();

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
        basePath={buildCanonicalClimbListUrl(boardDetails, parsedParams.angle)}
        tree="config-tuple"
      />
    </>
  );
}
