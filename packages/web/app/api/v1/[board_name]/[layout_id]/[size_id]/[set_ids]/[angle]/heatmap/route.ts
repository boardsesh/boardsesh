import { getHoldHeatmapData } from '@/app/lib/db/queries/climbs/holds-heatmap';
import { cachedGetHoldHeatmapData } from '@/app/lib/db/queries/climbs/holds-heatmap-cache';
import type { BoardRouteParameters, ErrorResponse, SearchRequestPagination } from '@/app/lib/types';
import { urlParamsToSearchParams } from '@/app/lib/url-utils';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';

export type HoldHeatmapResponse = {
  holdStats: Array<{
    holdId: number;
    totalUses: number;
    startingUses: number;
    totalAscents: number;
    handUses: number;
    footUses: number;
    finishUses: number;
    averageDifficulty: number | null;
    userAscents?: number; // Added for user-specific ascent data
    userAttempts?: number; // Added for user-specific attempt data
  }>;
};

export async function GET(
  req: Request,
  props: { params: Promise<BoardRouteParameters> },
): Promise<NextResponse<HoldHeatmapResponse | ErrorResponse>> {
  const rateLimitedResponse = await enforcePublicApiRateLimit(req);
  if (rateLimitedResponse) return rateLimitedResponse;

  const params = await props.params;
  // Extract search parameters from query string
  const query = new URL(req.url).searchParams;

  try {
    const parsedParams = await parseBoardRouteParamsWithSlugs(params);

    const searchParams: SearchRequestPagination = urlParamsToSearchParams(query);

    // Get NextAuth session for user-specific data
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    // Get the heatmap data - use cached version for anonymous requests only.
    // User-specific data is not cached to ensure fresh personal progress data.
    const holdStats = userId
      ? await getHoldHeatmapData(parsedParams, searchParams, userId)
      : await cachedGetHoldHeatmapData(parsedParams, searchParams);

    // Return response
    return NextResponse.json({
      holdStats,
    });
  } catch (error) {
    console.error('Error generating heatmap data:', error);
    return NextResponse.json({ error: 'Failed to generate hold heatmap data' }, { status: 500 });
  }
}
