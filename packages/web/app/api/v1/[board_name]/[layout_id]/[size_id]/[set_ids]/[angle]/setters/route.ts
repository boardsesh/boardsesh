import { type SetterStat, getSetterStats } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import type { BoardRouteParameters, ErrorResponse } from '@/app/lib/types';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import { NextResponse } from 'next/server';

export async function GET(
  req: Request,
  props: { params: Promise<BoardRouteParameters> },
): Promise<NextResponse<SetterStat[] | ErrorResponse>> {
  const rateLimitedResponse = await enforcePublicApiRateLimit(req);
  if (rateLimitedResponse) return rateLimitedResponse;

  const params = await props.params;

  try {
    const parsedParams = await parseBoardRouteParamsWithSlugs(params);

    // Extract search query parameter
    const url = new URL(req.url);
    const searchQuery = url.searchParams.get('search') || undefined;

    const setterStats = await getSetterStats(dbzRead, parsedParams, searchQuery);

    return NextResponse.json(setterStats);
  } catch (error) {
    console.error('Error fetching setter stats:', error);
    return NextResponse.json({ error: 'Failed to fetch setter stats' }, { status: 500 });
  }
}
