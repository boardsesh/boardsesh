import { sql, type SQL } from 'drizzle-orm';

/** Bayesian shrinkage strength: a setter needs ~this many climbs before their
 * own average dominates the board-wide prior. Keeps one-hit setters honest. */
const SHRINKAGE_C = 20;

/**
 * Recompute `board_setter_stats` from the catalog (pure existing-data; no
 * PostHog). `setter_score` is a shrinkage-adjusted, quality-gated estimate of a
 * setter's typical climb popularity:
 *
 *   ((Σ ascents + C·boardMean) / (climbCount + C)) · (avgQuality / 5)
 *
 * Ascents per climb are taken as the max across angles so a multi-angle climb
 * isn't counted several times. Heavy (scans board_climbs × board_climb_stats) —
 * run from the nightly job or a manual backfill, never per request.
 */
export function buildRecomputeSetterStatsSql(): SQL {
  return sql`
    INSERT INTO board_setter_stats
      (board_type, setter_username, climb_count, total_ascents, avg_ascents_per_climb, avg_quality, setter_score, updated_at)
    WITH climb_pop AS (
      SELECT bc.board_type, bc.setter_username, bc.uuid,
             MAX(COALESCE(s.ascensionist_count, 0)) AS asc_max,
             MAX(s.quality_average) AS quality
      FROM board_climbs bc
      JOIN board_climb_stats s
        ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid
      WHERE bc.is_listed = true
        AND bc.is_draft = false
        AND bc.setter_username IS NOT NULL
        AND bc.setter_username <> ''
      GROUP BY bc.board_type, bc.setter_username, bc.uuid
    ),
    agg AS (
      SELECT board_type, setter_username,
             COUNT(*)::int AS climb_count,
             SUM(asc_max)::bigint AS total_ascents,
             AVG(asc_max) AS avg_ascents,
             AVG(quality) AS avg_quality
      FROM climb_pop
      GROUP BY board_type, setter_username
    ),
    board_mean AS (
      SELECT board_type, AVG(avg_ascents) AS global_mean
      FROM agg
      GROUP BY board_type
    )
    SELECT a.board_type, a.setter_username, a.climb_count, a.total_ascents,
           a.avg_ascents,
           a.avg_quality,
           ((a.total_ascents + ${SHRINKAGE_C} * bm.global_mean) / (a.climb_count + ${SHRINKAGE_C}))
             * (COALESCE(a.avg_quality, 0) / 5.0) AS setter_score,
           now()
    FROM agg a
    JOIN board_mean bm ON bm.board_type = a.board_type
    ON CONFLICT (board_type, setter_username) DO UPDATE SET
      climb_count = EXCLUDED.climb_count,
      total_ascents = EXCLUDED.total_ascents,
      avg_ascents_per_climb = EXCLUDED.avg_ascents_per_climb,
      avg_quality = EXCLUDED.avg_quality,
      setter_score = EXCLUDED.setter_score,
      updated_at = now()
  `;
}
