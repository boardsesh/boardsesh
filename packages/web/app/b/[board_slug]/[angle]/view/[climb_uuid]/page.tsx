import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getClimb } from '@/app/lib/data/queries';
import BoardPageClimbsList from '@/app/components/board-page/board-page-climbs-list';
import { extractUuidFromSlug } from '@/app/lib/url-utils';
import { buildOgBoardRenderUrl, buildOverlayUrl } from '@/app/components/board-renderer/util';
import { scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';

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
      return createPageMetadata({
        title: t('metadata.view.fallbackTitle'),
        description: t('metadata.view.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }

    const parsedParams = {
      ...boardToRouteParams(board, Number(params.angle)),
      climb_uuid: extractUuidFromSlug(params.climb_uuid),
    };

    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const currentClimb = await getClimb(parsedParams);

    const climbName = currentClimb.name || `${boardDetails.board_name} Climb`;
    const climbGrade = currentClimb.difficulty || 'Unknown Grade';
    const setter = currentClimb.setter_username || 'Unknown Setter';
    const quality = currentClimb.quality_average || 0;
    const ascents = currentClimb.ascensionist_count || 0;
    const ogImagePath = buildOgBoardRenderUrl(boardDetails, currentClimb.frames);

    return createPageMetadata({
      title: t('metadata.view.title', { climbName, grade: climbGrade }),
      description: t('metadata.view.description', { climbName, grade: climbGrade, setter, quality, ascents }),
      path: `/b/${params.board_slug}/${params.angle}/view/${params.climb_uuid}`,
      locale,
      imagePath: ogImagePath,
      imageAlt: t('metadata.view.imageAlt', { climbName, grade: climbGrade, boardName: boardDetails.board_name }),
      // Unlisted is link-only by design, and a private board is readable to a
      // slug holder until #4087 masks it — neither belongs in the index. This
      // is indexation only; it is not the access control, which #4087 owns.
      robots: board.isUnlisted || !board.isPublic ? { index: false, follow: true } : undefined,
    });
  } catch {
    return createPageMetadata({
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

  const parsedParams = {
    ...boardToRouteParams(board, Number(params.angle)),
    climb_uuid: extractUuidFromSlug(params.climb_uuid),
  };

  try {
    const currentClimb = await getClimb(parsedParams);
    if (!currentClimb) notFound();

    const boardDetails = getBoardDetailsForBoard(parsedParams);
    scheduleOverlayWarming({ boardDetails, climbs: [currentClimb], variant: 'full' });
    const preloadUrl = currentClimb.frames ? buildOverlayUrl(boardDetails, currentClimb.frames, false) : null;

    return (
      <>
        {preloadUrl && <link rel="preload" as="image" href={preloadUrl} fetchPriority="high" />}
        <ClimbViewSeoFragment climb={currentClimb} boardDetails={boardDetails} />
        <BoardPageClimbsList
          {...parsedParams}
          boardDetails={boardDetails}
          initialClimbs={[]}
          initialHasMore
          initialOpenClimb={currentClimb}
        />
      </>
    );
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'digest' in error) {
      throw error;
    }
    console.error('Error fetching climb view:', error);
    notFound();
  }
}
