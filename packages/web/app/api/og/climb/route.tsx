import { type NextRequest, NextResponse } from 'next/server';
import { getClimb } from '@/app/lib/data/queries';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';
import { createOgImageHeaders } from '@/app/lib/seo/og';
import { trackServer } from '@/app/lib/analytics.server';
import { OG_BOT_DISTINCT_ID } from '@boardsesh/shared-schema';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const routeT0 = performance.now();

  try {
    const { searchParams } = new URL(request.url);

    const board_name = searchParams.get('board_name');
    const layout_id = searchParams.get('layout_id');
    const size_id = searchParams.get('size_id');
    const set_ids = searchParams.get('set_ids');
    const angle = searchParams.get('angle');
    const climb_uuid = searchParams.get('climb_uuid');

    if (!board_name || !layout_id || !size_id || !set_ids || !angle || !climb_uuid) {
      return new Response('Missing required parameters', { status: 400 });
    }

    const parsedParams = await parseBoardRouteParamsWithSlugs({
      board_name,
      layout_id,
      size_id,
      set_ids,
      angle,
      climb_uuid,
    });

    const dbT0 = performance.now();
    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const currentClimb = await getClimb(parsedParams);
    const dbMs = performance.now() - dbT0;

    if (!currentClimb?.frames) {
      return new Response('Climb not found', { status: 404 });
    }

    // OG fetches come from preview bots (Slack, iMessage, etc.); attribute to a
    // shared "og-bot" person so the count of share-previews stays usable in PostHog
    // without inflating people count.
    trackServer('OG Image Requested', {
      distinctId: OG_BOT_DISTINCT_ID,
      properties: {
        kind: 'climb',
        boardName: parsedParams.board_name,
        climbUuid: parsedParams.climb_uuid,
        userAgent: request.headers.get('user-agent') ?? null,
      },
    });

    const targetPath = buildOgBoardRenderUrl(boardDetails, currentClimb.frames);
    const targetUrl = new URL(targetPath, request.url);
    const response = NextResponse.redirect(targetUrl, 307);

    response.headers.set(
      'Server-Timing',
      `db;dur=${dbMs.toFixed(1)}, route;dur=${(performance.now() - routeT0).toFixed(1)}`,
    );

    const cacheHeaders = createOgImageHeaders({
      contentType: 'image/png',
      serverTiming: response.headers.get('Server-Timing') || undefined,
    });

    for (const [key, value] of Object.entries(cacheHeaders)) {
      if (key === 'Content-Type') {
        continue;
      }
      response.headers.set(key, value);
    }

    return response;
  } catch (error) {
    console.error('Error redirecting climb OG image:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Error generating image: ${message}`, { status: 500 });
  }
}
