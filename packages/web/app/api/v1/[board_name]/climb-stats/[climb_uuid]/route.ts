import { type ClimbStatsForAngle, getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import type { ErrorResponse, BoardName } from '@/app/lib/types';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { NextResponse } from 'next/server';

// Per-IP cap on this public, documented endpoint. The app itself fetches climb
// stats over GraphQL now, so the only traffic here is API consumers and bots —
// and a cache MISS (unique climb_uuid) is what costs a serverless invocation, so
// capping misses is exactly what blunts a scraper enumerating UUIDs. Runs in the
// Node serverless runtime, where this in-memory limiter works per-instance (same
// mechanism /api/auth/register already relies on). Strict cross-instance limiting
// would need a shared store (Vercel KV / Upstash) — tracked in #3096.
const MAX_REQUESTS_PER_MINUTE = 120;

export async function GET(
  req: Request,
  props: { params: Promise<{ board_name: string; climb_uuid: string }> },
): Promise<NextResponse<ClimbStatsForAngle[] | ErrorResponse>> {
  const clientIp = getClientIp(req);
  const { limited, retryAfterSeconds } = checkRateLimit(`climb-stats:${clientIp}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (limited) {
    // Log UA + IP so a future alert window can confirm whether this is a scraper.
    console.info(`[rate-limit] 429 climb-stats ip=${clientIp} ua=${req.headers.get('user-agent') ?? 'unknown'}`);
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      // Never advertise a 0/negative back-off — clients treat that as "retry now".
      { status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } },
    );
  }

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
    console.error('Error fetching climb stats:', error);
    return NextResponse.json({ error: 'Failed to fetch climb stats' }, { status: 500 });
  }
}
