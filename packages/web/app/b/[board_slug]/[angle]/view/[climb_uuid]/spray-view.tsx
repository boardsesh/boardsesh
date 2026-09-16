import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { ResolvedBoard } from '@/app/lib/board-slug-utils';
import SprayClimbFrontDoor from '@/app/components/spray-wall/spray-climb-front-door';
import { buildSprayOgImageUrl } from '@/app/components/board-renderer/util';
import { getClimb } from '@/app/lib/data/queries';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { fetchSprayWallPageData, resolveSprayPhotoUrl } from '@/app/lib/spray/spray-wall-render-data.server';
import { resolveSprayWallVisibility } from '@/app/lib/spray/spray-visibility';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { ParsedBoardRouteParametersWithUuid } from '@/app/lib/types';

/**
 * www's spray-wall climb page: the three states a wall can be in, and what each
 * one owes a reader and a crawler.
 *
 * | The wall is | The page |
 * | --- | --- |
 * | public | server-rendered, indexable, self-canonical, with an OG card |
 * | unlisted | server-rendered for whoever followed the link, `noindex, follow`, no OG card |
 * | private | `notFound()` |
 *
 * **Private is a 404, never a 403, and never for a signed-in owner either.**
 * Telling a stranger that a URL IS a wall they may not see is the leak; the app
 * is where an owner reads their own private wall, and www has no session-split
 * cache to serve one safely (`middleware.ts` puts a shared `s-maxage` on every
 * climb-view URL). So the decision here reads the board row the slug resolved
 * to and nothing else — no viewer, no token, and no round trip that would
 * confirm the wall exists.
 *
 * An unlisted wall renders at its slug for the same reason every other unlisted
 * board does: `/b/{slug}` is the link its owner shares, and the page carries
 * `noindex` so it never enters an index a stranger could search. The wall uuid
 * ride-along that unlocks unlisted WRITES in the app (`sprayWallUuid`, SW-14)
 * is a different capability for a different surface — this page only reads.
 */

type SprayViewMetadataArgs = {
  board: ResolvedBoard;
  parsedParams: ParsedBoardRouteParametersWithUuid;
  boardSlugParam: string;
};

/** `generateMetadata` for the spray branch of `/b/{slug}/{angle}/view/{climb}`. */
export async function buildSprayViewMetadata({
  board,
  parsedParams,
  boardSlugParam,
}: SprayViewMetadataArgs): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('climbs');
  const visibility = resolveSprayWallVisibility(board);

  const fallbackMetadata = createBoardContentPageMetadata({
    title: t('metadata.view.fallbackTitle'),
    description: t('metadata.view.fallbackDescription'),
    locale,
    robots: { index: false, follow: true },
  });

  if (visibility === 'private') return fallbackMetadata;

  const climb = await getClimb(parsedParams);
  if (!climb) return fallbackMetadata;

  const climbName = resolveClimbDisplayName(climb.name, 'spray');
  const grade = climb.difficulty || t('spray.unknownGrade');
  // A climb the crew voted off the wall still resolves — links and logbook
  // entries must not start 404ing — but it has no business ranking.
  const shouldNoindex = visibility !== 'public' || climb.is_hidden === true;

  // Self-canonical, and that is the departure from every other board. The
  // config-tuple tree this page's twin canonicalises into does not exist for
  // spray (`boardHasDeepConfigRoute` 404s `/spray/...`), so `/b/{slug}` is the
  // only URL this climb has. A noindex page still gets no `path` at all, for
  // the same reason the catalogue page withholds one: a canonical emitted from
  // a noindex URL is a signal Google can resolve by propagating the noindex.
  const canonicalPath = shouldNoindex
    ? undefined
    : constructBoardSlugViewUrl(boardSlugParam, parsedParams.angle, parsedParams.climb_uuid, climbName);

  // An unlisted wall gets NO card. `/og/climb` answers 404 for it by design —
  // the card would be fetched by an unfurler with no capability to present, and
  // it would have to be drawn from a photo in the private bucket.
  const ogImagePath = visibility === 'public' ? buildSprayOgImageUrl(board.layoutId, climb.frames) : null;

  return createBoardContentPageMetadata({
    title: t('spray.metadata.title', { climbName, grade, wallName: board.name }),
    description: t('spray.metadata.description', {
      climbName,
      grade,
      wallName: board.name,
      angle: parsedParams.angle,
      setter: climb.setter_username || t('spray.unknownSetter'),
    }),
    path: canonicalPath,
    locale,
    imagePath: ogImagePath ?? undefined,
    imageAlt: t('spray.photoAlt', { climbName, grade, wallName: board.name }),
    robots: shouldNoindex ? { index: false, follow: true } : undefined,
  });
}

type SprayViewPageArgs = {
  board: ResolvedBoard;
  parsedParams: ParsedBoardRouteParametersWithUuid;
};

/** The page body for the spray branch. Throws Next's 404 for a private wall. */
export default async function SprayViewPage({ board, parsedParams }: SprayViewPageArgs) {
  const visibility = resolveSprayWallVisibility(board);
  if (visibility === 'private') notFound();

  const [climb, wallData] = await Promise.all([getClimb(parsedParams), fetchSprayWallPageData(board.uuid)]);
  if (!climb || !wallData) notFound();

  return (
    <SprayClimbFrontDoor
      climb={climb}
      wallData={wallData}
      photoUrl={resolveSprayPhotoUrl(wallData, visibility === 'public')}
      angle={parsedParams.angle}
    />
  );
}
