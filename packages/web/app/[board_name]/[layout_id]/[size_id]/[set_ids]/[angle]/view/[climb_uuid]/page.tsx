import React from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import { BoardRouteParametersWithUuid } from '@/app/lib/types';
import { getClimb } from '@/app/lib/data/queries';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import {
  constructClimbViewUrl,
  isUuidOnly,
  constructClimbViewUrlWithSlugs,
  tryConstructSlugViewUrl,
} from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';

import { Metadata } from 'next';
import { fetchClimbDetailData } from '@/app/lib/data/climb-detail-data.server';
import ClimbDetailPageServer from '@/app/components/climb-detail/climb-detail-page.server';
import { scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';

export async function generateMetadata(props: { params: Promise<BoardRouteParametersWithUuid> }): Promise<Metadata> {
  const params = await props.params;

  try {
    const { parsedParams } = await parseRouteParams(params);
    const [boardDetails, currentClimb] = await Promise.all([getBoardDetailsForBoard(parsedParams), getClimb(parsedParams)]);

    const climbName = currentClimb.name || `${boardDetails.board_name} Climb`;
    const climbGrade = currentClimb.difficulty || 'Unknown Grade';
    const setter = currentClimb.setter_username || 'Unknown Setter';
    const description = `${climbName} - ${climbGrade} by ${setter}. Quality: ${currentClimb.quality_average || 0}/5. Ascents: ${currentClimb.ascensionist_count || 0}`;
    const climbUrl = tryConstructSlugViewUrl(
      parsedParams.board_name, parsedParams.layout_id, parsedParams.size_id,
      parsedParams.set_ids, parsedParams.angle, parsedParams.climb_uuid, climbName,
    ) ?? constructClimbViewUrl(parsedParams, parsedParams.climb_uuid, climbName);

    const ogImageUrl = new URL('/api/og/climb', 'https://boardsesh.com');
    ogImageUrl.searchParams.set('board_name', parsedParams.board_name);
    ogImageUrl.searchParams.set('layout_id', parsedParams.layout_id.toString());
    ogImageUrl.searchParams.set('size_id', parsedParams.size_id.toString());
    ogImageUrl.searchParams.set('set_ids', parsedParams.set_ids.join(','));
    ogImageUrl.searchParams.set('angle', parsedParams.angle.toString());
    ogImageUrl.searchParams.set('climb_uuid', parsedParams.climb_uuid);

    return {
      title: `${climbName} - ${climbGrade} | Boardsesh`,
      description,
      openGraph: {
        title: `${climbName} - ${climbGrade}`,
        description,
        type: 'website',
        url: climbUrl,
        images: [
          {
            url: ogImageUrl.toString(),
            width: 1200,
            height: 630,
            alt: `${climbName} - ${climbGrade} on ${boardDetails.board_name} board`,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: `${climbName} - ${climbGrade}`,
        description,
        images: [ogImageUrl.toString()],
      },
    };
  } catch {
    return {
      title: 'Climb View | Boardsesh',
      description: 'View climb details and beta videos',
    };
  }
}

export default async function DynamicResultsPage(props: { params: Promise<BoardRouteParametersWithUuid> }) {
  const params = await props.params;

  try {
    const { parsedParams, isNumericFormat } = await parseRouteParams(params);

    if (isNumericFormat || isUuidOnly(params.climb_uuid)) {
      const currentClimb = await getClimb(parsedParams);
      const layouts = await import('@/app/lib/data/queries').then((m) => m.getLayouts(parsedParams.board_name));
      const sizes = await import('@/app/lib/data/queries').then((m) =>
        m.getSizes(parsedParams.board_name, parsedParams.layout_id),
      );
      const sets = await import('@/app/lib/data/queries').then((m) =>
        m.getSets(parsedParams.board_name, parsedParams.layout_id, parsedParams.size_id),
      );

      const layout = layouts.find((l) => l.id === parsedParams.layout_id);
      const size = sizes.find((s) => s.id === parsedParams.size_id);
      const selectedSets = sets.filter((s) => parsedParams.set_ids.includes(s.id));

      if (layout && size && selectedSets.length > 0) {
        const newUrl = constructClimbViewUrlWithSlugs(
          parsedParams.board_name,
          layout.name,
          size.name,
          size.description,
          selectedSets.map((s) => s.name),
          parsedParams.angle,
          parsedParams.climb_uuid,
          currentClimb.name,
        );
        permanentRedirect(newUrl);
      }
    }

    const [boardDetails, currentClimb, detailData] = await Promise.all([
      getBoardDetailsForBoard(parsedParams),
      getClimb(parsedParams),
      fetchClimbDetailData({
        boardName: parsedParams.board_name,
        climbUuid: parsedParams.climb_uuid,
        angle: parsedParams.angle,
      }),
    ]);

    if (!currentClimb) {
      notFound();
    }

    scheduleOverlayWarming({ boardDetails, climbs: [currentClimb], variant: 'full' });

    const climbWithProcessedData = {
      ...currentClimb,
      communityGrade: detailData.communityGrade,
    };

    return (
      <ClimbDetailPageServer
        climb={climbWithProcessedData}
        boardDetails={boardDetails}
        angle={parsedParams.angle}
      />
    );
  } catch (error) {
    console.error('Error fetching results or climb:', error);
    notFound();
  }
}
