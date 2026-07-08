/**
 * Read-only analysis behind the "Concentration" bullet in docs/boardsesh-grade.md §2.
 *
 * The grade model caps per-user influence in coefficient estimation (σ_within,
 * the board offset, the LOO gate) as an independence guard against
 * pseudo-replication. The tempting counter-hypothesis — "power users grade
 * more accurately, so weight them up" — was tested here on prod (2026-07) and
 * rejected. This script reproduces that evidence:
 *
 *   1. Accuracy by activity: mean |deviation| of expressed opinions from the
 *      established crowd mean, bucketed by how many opinions the user has
 *      expressed. Same expressed-opinion filter as buildSigmaWithinSql.
 *   2. σ_within, user-weighted (current) vs tick-weighted (rejected
 *      alternative), per board, plus the top user's share of opinions.
 *   3. Per-user Kilter/Tension gap spread by send volume — if the spread
 *      shrank with volume, volume-weighting the offset would be defensible.
 *
 * Run: node --import tsx packages/db/scripts/analyze-grader-concentration.ts
 * Writes nothing; safe against prod with a read-only DB_URL.
 */
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { rowsOf } from '../src/queries/util/rows.js';

interface AccuracyBucketRow {
  bucket: string;
  users: number;
  opinions: number;
  avg_user_mae: string;
  mean_bias: string;
  sd_of_personal_bias: string;
}

interface SigmaCompareRow {
  board_type: string;
  users: number;
  opinions: number;
  sigma_user_weighted_current: string;
  sigma_tick_weighted_alt: string;
  top_user_pct_of_opinions: string;
}

interface OffsetSpreadRow {
  bucket: string;
  users: number;
  median_gap: string;
  mean_gap: string;
  sd_gap: string;
}

/**
 * Expressed opinions, mirroring buildSigmaWithinSql: latest tick per
 * user/climb/angle on ≥20-ascent climbs; native graded ticks count (opt-in ⇒
 * intentional, echo included) plus synced non-echo ticks (synced echoes are
 * probable auto-fills, not opinions).
 */
const expressedOpinionsCte = sql`
  SELECT DISTINCT ON (t.user_id, t.board_type, t.climb_uuid, t.angle)
         t.user_id,
         t.board_type,
         (t.difficulty - s.difficulty_average) AS deviation
  FROM boardsesh_ticks t
  JOIN board_climb_stats s
    ON s.board_type = t.board_type AND s.climb_uuid = t.climb_uuid AND s.angle = t.angle
  WHERE t.difficulty IS NOT NULL
    AND t.status IN ('flash', 'send')
    AND s.difficulty_average IS NOT NULL
    AND s.display_difficulty IS NOT NULL
    AND s.ascensionist_count >= 20
    AND (
      (t.aurora_id IS NULL AND t.kilter_id IS NULL)
      OR t.difficulty <> round(s.display_difficulty)
    )
  ORDER BY t.user_id, t.board_type, t.climb_uuid, t.angle, t.climbed_at DESC
`;

async function main(): Promise<void> {
  const { db, close } = createScriptDb();
  try {
    // Big scans over stats×ticks can exhaust /dev/shm on prod under parallel
    // gather (same failure mode as the honesty report, fixed in #3542).
    await db.execute(sql`SET max_parallel_workers_per_gather = 0`);

    const accuracyByActivity = rowsOf<AccuracyBucketRow>(
      await db.execute(sql`
        WITH expressed AS (${expressedOpinionsCte}),
        per_user AS (
          SELECT user_id,
                 COUNT(*)::int AS n_opinions,
                 AVG(deviation) AS personal_bias,
                 AVG(ABS(deviation)) AS mae
          FROM expressed
          GROUP BY user_id
          HAVING COUNT(*) >= 3
        )
        SELECT CASE
                 WHEN n_opinions >= 500 THEN 'e_500+'
                 WHEN n_opinions >= 100 THEN 'd_100-499'
                 WHEN n_opinions >= 30  THEN 'c_30-99'
                 WHEN n_opinions >= 10  THEN 'b_10-29'
                 ELSE 'a_3-9'
               END AS bucket,
               COUNT(*)::int AS users,
               SUM(n_opinions)::int AS opinions,
               ROUND(AVG(mae)::numeric, 3) AS avg_user_mae,
               ROUND(AVG(personal_bias)::numeric, 3) AS mean_bias,
               ROUND(STDDEV(personal_bias)::numeric, 3) AS sd_of_personal_bias
        FROM per_user
        GROUP BY 1
        ORDER BY 1
      `),
    );
    console.log('1. Expressed-opinion accuracy vs established crowd mean, by user activity:');
    console.table(accuracyByActivity);

    const sigmaWeightingCompare = rowsOf<SigmaCompareRow>(
      await db.execute(sql`
        WITH expressed AS (${expressedOpinionsCte}),
        per_user AS (
          SELECT board_type, user_id,
                 AVG(deviation * deviation) AS mean_sq_dev,
                 COUNT(*)::int AS n_opinions
          FROM expressed
          GROUP BY board_type, user_id
          HAVING COUNT(*) >= 3
        )
        SELECT board_type,
               COUNT(*)::int AS users,
               SUM(n_opinions)::int AS opinions,
               ROUND(SQRT(AVG(mean_sq_dev))::numeric, 3) AS sigma_user_weighted_current,
               ROUND(SQRT(SUM(mean_sq_dev * n_opinions) / SUM(n_opinions))::numeric, 3) AS sigma_tick_weighted_alt,
               ROUND((100.0 * MAX(n_opinions) / SUM(n_opinions))::numeric, 1) AS top_user_pct_of_opinions
        FROM per_user
        GROUP BY board_type
        ORDER BY opinions DESC
      `),
    );
    console.log('\n2. σ_within — user-weighted (current) vs tick-weighted (rejected):');
    console.table(sigmaWeightingCompare);

    const offsetSpreadByVolume = rowsOf<OffsetSpreadRow>(
      await db.execute(sql`
        WITH per_board AS (
          SELECT user_id, board_type,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY difficulty) AS median_grade,
                 COUNT(*)::int AS n_sends
          FROM boardsesh_ticks
          WHERE difficulty IS NOT NULL
            AND status IN ('flash', 'send')
            AND board_type IN ('kilter', 'tension')
          GROUP BY user_id, board_type
          HAVING COUNT(*) >= 10
        ),
        paired AS (
          SELECT (t.median_grade - k.median_grade) AS gap,
                 LEAST(k.n_sends, t.n_sends) AS min_side_sends
          FROM per_board k
          JOIN per_board t ON t.user_id = k.user_id AND t.board_type = 'tension'
          WHERE k.board_type = 'kilter'
        )
        SELECT CASE
                 WHEN min_side_sends >= 100 THEN 'c_100+'
                 WHEN min_side_sends >= 30  THEN 'b_30-99'
                 ELSE 'a_10-29'
               END AS bucket,
               COUNT(*)::int AS users,
               ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::numeric, 2) AS median_gap,
               ROUND(AVG(gap)::numeric, 2) AS mean_gap,
               ROUND(STDDEV(gap)::numeric, 2) AS sd_gap
        FROM paired
        GROUP BY 1
        ORDER BY 1
      `),
    );
    console.log('\n3. Per-user Kilter/Tension gap by shared-user send volume:');
    console.table(offsetSpreadByVolume);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
