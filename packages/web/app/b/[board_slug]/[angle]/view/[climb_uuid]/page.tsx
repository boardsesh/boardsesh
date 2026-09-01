import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug, boardToRouteParamsFromAngleSegment } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getClimb, getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '@/app/lib/data/front-door-data.server';
import ClimbFrontDoor from '@/app/components/climb-front-door/climb-front-door';
import { buildCanonicalClimbViewUrl, extractUuidFromSlug } from '@/app/lib/url-utils';
import { buildOgBoardRenderUrl, buildOverlayPreloadUrls } from '@/app/components/board-renderer/util';
import { scheduleOgImageWarming } from '@/app/lib/warm-overlay-cache';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { selectCanonicalClimbAngle } from '@/app/lib/seo/canonical-climb-angle';

type BoardSlugViewRouteParams = { board_slug: string; angle: string; climb_uuid: string };

type BoardSlugViewPageProps = {
  params: Promise<BoardSlugViewRouteParams>;
};

export async function generateMetadata(props: BoardSlugViewPageProps): Promise<Metadata> {
  const params = await props.params;
  const { t, locale } = await getServerTranslation('climbs');

  try {
    const board = await resolveBoardBySlug(params.board_slug);
    if (!board) {
      return createBoardContentPageMetadata({
        title: t('metadata.view.fallbackTitle'),
        description: t('metadata.view.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }

    const parsedBoardParams = boardToRouteParamsFromAngleSegment(board, params.angle);
    if (!parsedBoardParams) {
      return createBoardContentPageMetadata({
        title: t('metadata.view.fallbackTitle'),
        description: t('metadata.view.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }
    const parsedParams = { ...parsedBoardParams, climb_uuid: extractUuidFromSlug(params.climb_uuid) };

    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const [currentClimb, angleStats] = await Promise.all([
      getClimb(parsedParams),
      getClimbStatsForAllAngles(parsedParams),
    ]);
    if (!currentClimb) {
      return createBoardContentPageMetadata({
        title: t('metadata.view.fallbackTitle'),
        description: t('metadata.view.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }

    const climbName = resolveClimbDisplayName(currentClimb.name, boardDetails.board_name);
    const climbGrade = currentClimb.difficulty || 'Unknown Grade';
    const setter = currentClimb.setter_username || 'Unknown Setter';
    const quality = currentClimb.quality_average || 0;
    const ascents = currentClimb.ascensionist_count || 0;
    const ogImagePath = buildOgBoardRenderUrl(boardDetails, currentClimb.frames);

    // Unlisted is link-only by design, and a private board is readable to a
    // slug holder until #4087 masks it — neither belongs in the index. This is
    // indexation only; it is not the access control, which #4087 owns.
    const shouldNoindex = board.isUnlisted || !board.isPublic;

    // A1: this page canonicalises INTO the config-tuple tree rather than
    // self-canonicalising, via the same builder that tree uses — `/b/{slug}`
    // names a board a user owns, not a climb config, so most climbs have no
    // `/b` URL and popular configs have many. One climb, one canonical.
    //
    // A noindex page gets NO `path` at all, so `createBoardContentPageMetadata`
    // returns early and emits no `alternates`. A canonical pointing from a noindex URL at an indexable
    // twin is a conflicting signal Google can resolve by propagating the
    // noindex — deindexing a public config-tuple climb page because one private
    // board happens to share its configuration.
    const canonicalAngle = selectCanonicalClimbAngle({
      boardName: parsedParams.board_name,
      catalogAngle: currentClimb.catalogAngle,
      angleStats,
    });
    const canonicalPath = shouldNoindex
      ? undefined
      : buildCanonicalClimbViewUrl(boardDetails, canonicalAngle, parsedParams.climb_uuid, climbName);

    return createBoardContentPageMetadata({
      title: t('metadata.view.title', { climbName, grade: climbGrade }),
      description: t('metadata.view.description', { climbName, grade: climbGrade, setter, quality, ascents }),
      path: canonicalPath,
      locale,
      imagePath: ogImagePath,
      imageAlt: t('metadata.view.imageAlt', { climbName, grade: climbGrade, boardName: boardDetails.board_name }),
      robots: shouldNoindex ? { index: false, follow: true } : undefined,
    });
  } catch {
    return createBoardContentPageMetadata({
      title: t('metadata.view.fallbackTitle'),
      description: t('metadata.view.fallbackDescription'),
      locale,
      robots: { index: false, follow: true },
    });
  }
}

export default async function BoardSlugViewPage(props: BoardSlugViewPageProps) {
  const params = await props.params;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const parsedBoardParams = boardToRouteParamsFromAngleSegment(board, params.angle);
  if (!parsedBoardParams) return notFound();
  const parsedParams = { ...parsedBoardParams, climb_uuid: extractUuidFromSlug(params.climb_uuid) };

  try {
    const currentClimb = await getClimb(parsedParams);
    if (!currentClimb) notFound();

    const boardDetails = getBoardDetailsForBoard(parsedParams);

    const [angleStats, similarClimbs, betaLinks] = await Promise.all([
      getClimbStatsForAllAngles(parsedParams),
      getFrontDoorSimilarClimbs({
        boardType: parsedParams.board_name,
        layoutId: parsedParams.layout_id,
        climbUuid: parsedParams.climb_uuid,
        angle: parsedParams.angle,
      }),
      getFrontDoorBetaLinks({ boardType: parsedParams.board_name, climbUuid: parsedParams.climb_uuid }),
    ]);
    const canonicalAngle = selectCanonicalClimbAngle({
      boardName: parsedParams.board_name,
      catalogAngle: currentClimb.catalogAngle,
      angleStats,
    });

    scheduleOgImageWarming({ boardDetails, climb: currentClimb });
    const preloadUrls = buildOverlayPreloadUrls(boardDetails, currentClimb.frames, false);

    return (
      <>
        {preloadUrls.map((preloadUrl) => (
          <link key={preloadUrl} rel="preload" as="image" href={preloadUrl} fetchPriority="high" />
        ))}
        <ClimbFrontDoor
          climb={currentClimb}
          boardDetails={boardDetails}
          angle={parsedParams.angle}
          canonicalAngle={canonicalAngle}
          angleStats={angleStats}
          similarClimbs={similarClimbs}
          betaLinks={betaLinks}
          // The CTA hands off the `/b` pathname the reader is actually on: the
          // app serves both URL shapes (post-#3823), and rewriting it to the
          // config-tuple twin would drop the board context they arrived with.
          // Not the canonical — `generateMetadata` above points that into the
          // config-tuple tree (A1).
          handoffPath={`/b/${params.board_slug}/${params.angle}/view/${params.climb_uuid}`}
          tree="slug"
          // Same condition `generateMetadata` uses to withhold the canonical, for
          // the same reason: on a noindex page a `CreativeWork.url` naming the
          // indexable config-tuple twin re-introduces exactly the conflicting
          // signal the missing `alternates` block avoids.
          noindex={board.isUnlisted || !board.isPublic}
        />
      </>
    );
  } catch (error) {
    // Same contract as the config-tuple twin: a missing climb is the
    // `notFound()` above, a failed read is a 500. Swallowing a brownout into a
    // 404 on an indexed URL reads as "delete this page". A digest is Next.js
    // control flow (the `notFound()` above), not a failure — logging it would
    // bury the brownout signal under routine 404s.
    if (!(error !== null && typeof error === 'object' && 'digest' in error)) {
      console.error('Error fetching climb view:', error);
    }
    throw error;
  }
}
