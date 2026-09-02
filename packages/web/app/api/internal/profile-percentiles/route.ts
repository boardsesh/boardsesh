import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/db';
import { USER_CLIMB_PERCENTILE_CACHE_TAG } from '@/app/lib/graphql/server-cached-client';
import { userClimbPercentiles } from '@boardsesh/db/schema';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { reportHandledError } from '@/app/lib/observability/report-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const log = createRequestLogger(request);
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const db = getDb();

    // Single statement is already atomic — no explicit transaction needed.
    await db.execute(sql`
      WITH distinct_counts AS (
        SELECT
          bt.user_id,
          COUNT(DISTINCT bt.climb_uuid)::int AS total_distinct_climbs
        FROM boardsesh_ticks bt
        WHERE bt.status IN ('flash', 'send')
        GROUP BY bt.user_id
      ),
      ranked_active_users AS (
        SELECT
          dc.user_id,
          dc.total_distinct_climbs,
          (RANK() OVER (ORDER BY dc.total_distinct_climbs ASC) - 1)::int AS users_with_fewer
        FROM distinct_counts dc
      ),
      totals AS (
        SELECT COUNT(*)::int AS total_active_users
        FROM distinct_counts
      )
      INSERT INTO user_climb_percentiles (
        user_id,
        total_distinct_climbs,
        percentile,
        total_active_users,
        computed_at
      )
      SELECT
        u.id AS user_id,
        COALESCE(dc.total_distinct_climbs, 0)::int AS total_distinct_climbs,
        CASE
          WHEN dc.user_id IS NULL OR totals.total_active_users = 0 THEN 0
          ELSE (
            ROUND(
              ((COALESCE(ranked_active_users.users_with_fewer, 0)::numeric / totals.total_active_users::numeric) * 1000)
            ) / 10
          )::double precision
        END AS percentile,
        totals.total_active_users,
        NOW()
      FROM users u
      CROSS JOIN totals
      LEFT JOIN distinct_counts dc
        ON dc.user_id = u.id
      LEFT JOIN ranked_active_users
        ON ranked_active_users.user_id = u.id
      ON CONFLICT (user_id) DO UPDATE
        SET total_distinct_climbs = EXCLUDED.total_distinct_climbs,
            percentile = EXCLUDED.percentile,
            total_active_users = EXCLUDED.total_active_users,
            computed_at = EXCLUDED.computed_at
    `);

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(userClimbPercentiles);

    revalidateTag(USER_CLIMB_PERCENTILE_CACHE_TAG, { expire: 0 });

    return NextResponse.json({
      refreshedUsers: Number(countResult?.count ?? 0),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reportHandledError(error, { logger: log, message: 'Profile percentile refresh failed' });
    return NextResponse.json({ error: 'Profile percentile refresh failed' }, { status: 500 });
  }
}
