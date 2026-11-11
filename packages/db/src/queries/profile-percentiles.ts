import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/** Global ranking must be recomputed after identity consolidation changes the active population. */
export async function refreshUserClimbPercentiles(
  database: Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'execute'>,
  targetUserId?: string,
): Promise<void> {
  await database.execute(sql`
      WITH distinct_counts AS (
        SELECT
          bt.user_id,
          COUNT(DISTINCT bt.climb_uuid)::int AS total_distinct_climbs
        FROM boardsesh_ticks bt
        WHERE bt.status IN ('flash', 'send')
          AND NOT EXISTS (SELECT 1 FROM account_consolidation_members acm WHERE acm.source_user_id = bt.user_id AND acm.status = 'applied')
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
      WHERE NOT EXISTS (SELECT 1 FROM account_consolidation_members acm WHERE acm.source_user_id = u.id AND acm.status = 'applied')
        AND (${targetUserId ?? null}::text IS NULL OR u.id=${targetUserId ?? null}::text)
      ON CONFLICT (user_id) DO UPDATE
        SET total_distinct_climbs = EXCLUDED.total_distinct_climbs,
            percentile = EXCLUDED.percentile,
            total_active_users = EXCLUDED.total_active_users,
            computed_at = EXCLUDED.computed_at
  `);
}
