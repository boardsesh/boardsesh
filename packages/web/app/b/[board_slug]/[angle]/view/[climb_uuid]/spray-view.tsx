import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { ResolvedBoard } from '@/app/lib/board-slug-utils';
import SprayClimbFrontDoor from '@/app/components/spray-wall/spray-climb-front-door';
import { buildSprayOgImageUrl } from '@/app/components/board-renderer/util';
import { getClimb } from '@/app/lib/data/queries';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import {
  fetchSprayWallArtChoice,
  fetchSprayWallPageData,
  resolveSprayArtUrl,
  resolveSprayPhotoUrl,
} from '@/app/lib/spray/spray-wall-render-data.server';
import { resolveSprayWallAccess, resolveSprayWallVisibility } from '@/app/lib/spray/spray-visibility';
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
 * | unlisted | server-rendered only with `?wall=<its uuid>`, `noindex, follow`, no canonical, no OG card |
 * | private | `notFound()` |
 *
 * Who passes is `resolveSprayWallAccess`, the same rule the wall's own share link
 * (`../../list/spray-wall-view`) applies, so a wrong `?wall=` is a 404 on both.
 *
 * **Private is a 404, never a 403, and never for a signed-in owner either.**
 * Telling a stranger that a URL IS a wall they may not see is the leak; the app
 * is where an owner reads their own private wall, and www has no session-split
 * cache to serve one safely (`middleware.ts` puts a shared `s-maxage` on every
 * climb-view URL). So the decision here reads the board row the slug resolved
 * to and nothing else — no viewer, no token, and no round trip that would
 * confirm the wall exists.
 *
 * An unlisted wall renders only for a request carrying its uuid. The slug is
 * derived from the wall's name, so it is a guess; the uuid is the capability the
 * app's share link carries (`buildSprayClimbShareUrl` / `buildSprayWallShareUrl`),
 * the same one `sprayWall(uuid)` honours. The page passes it to `boardBySlug` as
 * `wallUuid`, and checks it again here because a signed-in owner gets their
 * unlisted row without one, and this path carries a shared `s-maxage`.
 *
 * The page is `noindex, follow` and emits NO canonical, so the uuid appears in no
 * tag a crawler would follow or store: a canonical without it would point at a
 * URL that answers 404, and one with it would publish the capability.
 */

type SprayViewMetadataArgs = {
  board: ResolvedBoard;
  parsedParams: ParsedBoardRouteParametersWithUuid;
  boardSlugParam: string;
  wallParam: string | string[] | undefined;
};

/** `generateMetadata` for the spray branch of `/b/{slug}/{angle}/view/{climb}`. */
export async function buildSprayViewMetadata({
  board,
  parsedParams,
  boardSlugParam,
  wallParam,
}: SprayViewMetadataArgs): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('climbs');
  const visibility = resolveSprayWallVisibility(board);

  const fallbackMetadata = createBoardContentPageMetadata({
    title: t('metadata.view.fallbackTitle'),
    description: t('metadata.view.fallbackDescription'),
    locale,
    robots: { index: false, follow: true },
  });

  if (resolveSprayWallAccess(board, wallParam) === 'refuse') return fallbackMetadata;

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
  wallParam: string | string[] | undefined;
};

/** The page body for the spray branch. Throws Next's 404 for anything refused. */
export default async function SprayViewPage({ board, parsedParams, wallParam }: SprayViewPageArgs) {
  if (resolveSprayWallAccess(board, wallParam) === 'refuse') notFound();
  const visibility = resolveSprayWallVisibility(board);

  const [climb, wallData] = await Promise.all([getClimb(parsedParams), fetchSprayWallPageData(board.uuid)]);
  if (!climb || !wallData) notFound();
  const art = await fetchSprayWallArtChoice(board.uuid, wallData.versionNumber);

  return (
    <SprayClimbFrontDoor
      climb={climb}
      wallData={wallData}
      photoUrl={resolveSprayPhotoUrl(wallData, visibility === 'public')}
      art={art}
      artUrl={resolveSprayArtUrl(wallData.wall.uuid, art)}
      angle={parsedParams.angle}
    />
  );
}
