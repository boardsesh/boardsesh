import React from 'react';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { SearchRequestPagination } from '@/app/lib/types';
import {
  resolveBoardBySlug,
  resolveBoardBySlugAsStranger,
  boardToRouteParamsFromAngleSegment,
  type ResolvedBoard,
} from '@/app/lib/board-slug-utils';
import StaticListFrontDoor from '@/app/components/climb-front-door/static-list-front-door';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { fetchFrontDoorListPage } from '@/app/lib/data/list-page-data.server';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { boardConfigForSearch } from '@/app/lib/seo/climb-display';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { buildOgContentVersion, buildOgFamilyImageUrl } from '@/app/lib/seo/og-family';
import {
  isFrontDoorPageOutOfRange,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { WALL_CAPABILITY_PARAM, readWallCapability } from '@/app/lib/spray/spray-visibility';
import { BOARD_INVITE_PARAM, readBoardInviteToken } from '@/app/lib/board-invite';
import SprayWallListPage, { buildSprayWallListMetadata } from '@/app/b/[board_slug]/[angle]/list/spray-wall-view';
import { boardTypeProperty } from '@boardsesh/analytics';
import QrLandingTracker from '@/app/components/climb-front-door/qr-landing-tracker';
import BoardReportLink from '@/app/components/directory-reports/board-report-link';
import { isDirectoryReportsEnabled } from '@/app/lib/directory-reports/directory-reports-flag';
import { isDirectorySetupSuggestionsEnabled } from '@/app/lib/directory-reports/directory-setup-suggestions-flag';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';

/**
 * A wall takes its own branch out of both exports below: it has no catalogue row
 * for `getBoardImageDetailsForBoard` to resolve, and this path is where its SHARE LINK
 * lands rather than a climb list. `./spray-wall-view` owns the capability rule.
 */
const SPRAY_BOARD_TYPE = 'spray';

/**
 * The board's share card, or null when a stranger could not open the board and
 * so the backend card would answer 404: private, followers-only, invite-only and
 * admin-hidden boards. The URL carries the slug and nothing else, so no invite
 * token or wall capability can ever reach it. A lookup that fails costs the
 * card, never the page's metadata.
 */
async function resolveBoardShareImage(board: ResolvedBoard): Promise<string | null> {
  let strangerView: ResolvedBoard | null;
  try {
    strangerView = await resolveBoardBySlugAsStranger(board.slug);
  } catch {
    return null;
  }
  if (!strangerView) return null;
  return buildOgFamilyImageUrl(
    'place',
    { kind: 'board', slug: strangerView.slug },
    buildOgContentVersion(
      strangerView.name,
      strangerView.boardType,
      strangerView.layoutId,
      strangerView.sizeId,
      strangerView.setIds,
      strangerView.angle,
      strangerView.locationName ?? null,
    ),
  );
}

type BoardSlugListPageProps = {
  params: Promise<{ board_slug: string; angle: string }>;
  // `SearchRequestPagination` names the filters this page reads; `?wall=` is not
  // one of them, it is the share-link capability a spray wall arrives with, so
  // the raw string form rides alongside rather than being bolted onto the filter
  // type every other caller of that type shares.
  searchParams: Promise<
    SearchRequestPagination & {
      [WALL_CAPABILITY_PARAM]?: string | string[];
      [BOARD_INVITE_PARAM]?: string | string[];
    }
  >;
};

export async function generateMetadata(props: BoardSlugListPageProps): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const { t, locale } = await getServerTranslation('climbs');

  try {
    // The `?wall=` capability rides along so an unlisted wall's share link gets the
    // wall's own (noindex) title; the backend ignores a uuid that is not this wall's.
    const board = await resolveBoardBySlug(params.board_slug, readWallCapability(searchParams[WALL_CAPABILITY_PARAM]));
    if (!board) {
      return createBoardContentPageMetadata({
        title: t('metadata.list.fallbackTitle'),
        description: t('metadata.list.fallbackDescription'),
        locale,
      });
    }

    // A wall's share link lands here, so this path has a page — but never an
    // indexable one, because the URL an unlisted wall is read at carries a
    // capability. See `./spray-wall-view`.
    if (board.boardType === SPRAY_BOARD_TYPE) {
      return await buildSprayWallListMetadata(board, searchParams[WALL_CAPABILITY_PARAM]);
    }

    const parsedParams = boardToRouteParamsFromAngleSegment(board, params.angle);
    if (!parsedParams) {
      return createBoardContentPageMetadata({
        title: t('metadata.list.fallbackTitle'),
        description: t('metadata.list.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }
    const angle = parsedParams.angle;
    const page = parseFrontDoorPage(searchParams.page);
    const boardDetails = getBoardImageDetailsForBoard(parsedParams);
    // The same layout-and-size name the config-tuple twin titles itself with.
    const boardName = boardConfigForSearch(boardDetails);

    // A1: canonicalise into the config-tuple tree via the same builder that
    // tree's own `/list` page calls, so one board config emits one canonical.
    // `resolveListPageIndexation` then applies the SAME filter/pagination
    // doctrine both trees use — see its docblock for why a hidden board is the
    // one case that emits no canonical at all.
    //
    // Unlisted is link-only by design, and a private board is readable to a
    // slug holder until #4087 masks it — neither belongs in the index. This is
    // indexation only; it is not the access control, which #4087 owns.
    const { path } = resolveListPageIndexation({
      cleanPath: buildCanonicalClimbListUrl(boardDetails, angle),
      page,
      searchParams: searchParams as unknown as ListPageSearchParams,
      boardIsHidden: board.isUnlisted || !board.isPublic || board.gymIsListed === false,
    });

    const imageUrl = await resolveBoardShareImage(board);

    return createBoardContentPageMetadata({
      title:
        page > 1
          ? t('metadata.list.paginatedTitle', { boardName, angle: params.angle, page })
          : t('metadata.list.title', { boardName, angle: params.angle }),
      description: t('metadata.list.description', { boardName, angle: params.angle }),
      ogTitle: t('metadata.list.ogTitle', { name: board.name, angle: params.angle }),
      ogDescription: t('metadata.list.ogDescription'),
      path,
      locale,
      // Catalogue list aliases stay out of search results and let crawlers
      // follow links to the catalogue. Keep the canonical policy above.
      // The spray-wall branch above owns its independent visibility policy.
      robots: { index: false, follow: true },
      ...(imageUrl ? { imagePath: imageUrl } : {}),
    });
  } catch {
    return createBoardContentPageMetadata({
      title: t('metadata.list.fallbackTitle'),
      description: t('metadata.list.fallbackDescription'),
      locale,
    });
  }
}

export default async function BoardSlugListPage(props: BoardSlugListPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

  // A home board's share link redeems in one place, the bare `/b/{slug}` page,
  // which signs the visitor in or joins them and then lands here without it.
  const inviteToken = readBoardInviteToken(searchParams[BOARD_INVITE_PARAM]);
  if (inviteToken) redirect(`/b/${encodeURIComponent(params.board_slug)}?${BOARD_INVITE_PARAM}=${inviteToken}`);

  // The capability has to reach the backend: without it an anonymous caller gets
  // no row at all for an unlisted wall, because a slug alone is a guess.
  const board = await resolveBoardBySlug(params.board_slug, readWallCapability(searchParams[WALL_CAPABILITY_PARAM]));
  if (!board) {
    return notFound();
  }

  // Not a climb list for a wall: this is where its share link lands, and the
  // `?wall=` capability is what opens an unlisted one. Taken before the page
  // ceiling and the angle parse below, because neither applies — a wall has one
  // fixed angle and no pagination — and before `getBoardImageDetailsForBoard`, which
  // has no catalogue row to resolve for a wall and throws.
  //
  // Both branches mount `QrLandingTracker`: this page is where a printed
  // board code lands after the `/b/{slug}` hop, so this is where a scan is counted.
  if (board.boardType === SPRAY_BOARD_TYPE) {
    return (
      <>
        <QrLandingTracker kind="board" boardType={SPRAY_BOARD_TYPE} />
        <SprayWallListPage board={board} wallParam={searchParams[WALL_CAPABILITY_PARAM]} />
      </>
    );
  }

  // Same ceiling as the config-tuple twin: nothing links past
  // `FRONT_DOOR_MAX_INDEXABLE_PAGE`, so a page number beyond the grace band is a
  // guess and gets a 404 rather than a deep `OFFSET`.
  if (isFrontDoorPageOutOfRange(searchParams.page)) return notFound();

  const parsedParams = boardToRouteParamsFromAngleSegment(board, params.angle);
  if (!parsedParams) return notFound();
  const page = parseFrontDoorPage(searchParams.page);
  const [listData, reportsEnabled, setupSuggestionsEnabled] = await Promise.all([
    fetchFrontDoorListPage(parsedParams, page),
    isDirectoryReportsEnabled(),
    isDirectorySetupSuggestionsEnabled(),
  ]);
  if (!listData) return notFound();
  const { boardDetails, climbs, hasMore, preloadUrls } = listData;
  const reportLocale = reportsEnabled ? await getLocale() : null;
  // The app link after a suggestion changed the board. Read only when the dialog can show it.
  const reportStoreLabels = reportsEnabled && setupSuggestionsEnabled ? await getStoreButtonLabels() : null;

  return (
    <>
      <QrLandingTracker kind="board" boardType={boardTypeProperty(board.boardType).boardType} />
      {preloadUrls.map((preloadUrl) => (
        <link key={preloadUrl} rel="preload" as="image" href={preloadUrl} fetchPriority="high" />
      ))}
      <StaticListFrontDoor
        boardDetails={boardDetails}
        boardSlug={board.slug}
        angle={parsedParams.angle}
        climbs={climbs}
        hasMore={hasMore}
        page={page}
        // Pagination and the CTA stay on the `/b` pathname the reader is on —
        // the canonical points at the config-tuple tree, the navigation does
        // not move them off the board they arrived through.
        basePath={`/b/${params.board_slug}/${params.angle}/list`}
        tree="slug"
        // Same hidden-board test `generateMetadata` feeds `resolveListPageIndexation`.
        // A private or unlisted board must not emit a BreadcrumbList naming the public
        // config-tuple twin it canonicalises nowhere near.
        noindex={board.isUnlisted || !board.isPublic}
        // One answer for every reader (the flag is not per person), so the
        // page's shared cache holds the same HTML for everyone.
        reportProblem={
          reportLocale ? (
            // The board layout loads `climbs` and `feed`; the dialog's words are
            // the `boards` catalogue's `report` branch, and only that branch ships.
            <I18nProvider locale={reportLocale} namespaces={['boards']} resourceKeys={{ boards: ['report'] }}>
              <BoardReportLink
                boardUuid={board.uuid}
                setupSuggestionsEnabled={setupSuggestionsEnabled}
                storeLabels={reportStoreLabels}
              />
            </I18nProvider>
          ) : undefined
        }
      />
    </>
  );
}
