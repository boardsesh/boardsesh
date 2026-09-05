import { type ClimbStatsForAngle, getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import type { ErrorResponse, BoardName } from '@/app/lib/types';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { reportHandledError } from '@/app/lib/observability/report-error';
import { NextResponse } from 'next/server';

// The template, not the resolved path: every climb_uuid is distinct, so logging
// the concrete pathname would give this handler as many `route` values as there
// are climbs and make "how often does this endpoint error" unanswerable.
const ROUTE = '/api/v1/[board_name]/climb-stats/[climb_uuid]';

export async function GET(
  req: Request,
  props: { params: Promise<{ board_name: string; climb_uuid: string }> },
): Promise<NextResponse<ClimbStatsForAngle[] | ErrorResponse>> {
  const log = createRequestLogger(req, { route: ROUTE });
  const rateLimitedResponse = await enforcePublicApiRateLimit(req);
  if (rateLimitedResponse) return rateLimitedResponse;

  const params = await props.params;
  try {
    // Create a minimal parsed params object with just what we need
    const parsedParams = {
      board_name: params.board_name as BoardName,
      climb_uuid: params.climb_uuid,
      // These aren't needed for the climb stats query, but required by the interface
      layout_id: 0,
      size_id: 0,
      set_ids: [] as number[],
      angle: 0,
    };

    const climbStats = await getClimbStatsForAllAngles(parsedParams);

    // Cache at the edge: climb stats change slowly (only when ticks are logged),
    // so serve repeat hits from the CDN instead of invoking the function and
    // hitting Postgres on every request. 5 min fresh, 1 day stale-while-revalidate.
    return NextResponse.json(climbStats, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400' },
    });
  } catch (error) {
    reportHandledError(error, {
      logger: log,
      message: 'Failed to fetch climb stats',
      tags: { boardName: params.board_name },
    });
    return NextResponse.json({ error: 'Failed to fetch climb stats' }, { status: 500 });
  }
}
