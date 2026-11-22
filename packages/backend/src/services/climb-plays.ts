import { sql, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';

export const PLAY_REFRESH_BATCH_SIZE = 500;

type PlaysDatabase = { execute(query: SQLWrapper): PromiseLike<unknown> };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const changeSchema = z.object({
  boardType: z.string(),
  climbUuid: z.string(),
  angle: z.number().int(),
  playCount: count,
});
const planSchema = z.object({
  changes: z.array(changeSchema),
  qualifyingPlays: count,
  unmatchedKeys: count,
  unmatchedPlays: count,
  excludedRecords: count,
  measuredAt: z.string(),
});
export type PlaysRefreshPlan = z.infer<typeof planSchema>;

/** One SELECT gives the event timeline, existing stats, and diagnostics one primary snapshot. */
export async function planClimbPlays(database: PlaysDatabase): Promise<PlaysRefreshPlan> {
  // Window functions and run grouping cannot be expressed by the ORM builder.
  const result = await database.execute(sql`
    WITH classified AS MATERIALIZED (
      SELECT e.board_id, e.board_type, coalesce(a.canonical_uuid,e.climb_uuid) AS climb_uuid,
        e.angle,e.confirmed_at,e.seq,e.user_id,
        (b.owner_id='00000000-0000-0000-0000-000000000000' AND b.slug LIKE 'presence-%') AS shared,
        (b.deleted_at IS NOT NULL OR b.slug LIKE 'boardsesh-qa-%' OR coalesce(g.slug='boardsesh-qa',false)) AS excluded
      FROM board_climb_events e
      JOIN user_boards b ON b.id=e.board_id
      LEFT JOIN gyms g ON g.id=b.gym_id
      LEFT JOIN board_climb_aliases a ON a.board_type=e.board_type AND a.alias_uuid=e.climb_uuid
      WHERE e.source='boardsesh' AND e.confirmed_at <= timezone('UTC',statement_timestamp())
    ), eligible AS (
      SELECT *,CASE WHEN shared THEN user_id ELSE NULL END AS reporter
      FROM classified WHERE NOT excluded AND (NOT shared OR user_id IS NOT NULL)
    ), ordered AS (
      SELECT *,lag(climb_uuid) OVER timeline AS previous_climb,
        lag(angle) OVER timeline AS previous_angle,lag(confirmed_at) OVER timeline AS previous_at
      FROM eligible WINDOW timeline AS (PARTITION BY board_id,reporter ORDER BY confirmed_at,seq)
    ), numbered AS (
      SELECT *,sum(CASE WHEN previous_climb=climb_uuid AND previous_angle=angle
        AND confirmed_at-previous_at <= interval '30 minutes' THEN 0 ELSE 1 END)
        OVER (PARTITION BY board_id,reporter ORDER BY confirmed_at,seq) AS run_id FROM ordered
    ), runs AS (
      SELECT board_id,reporter,board_type,climb_uuid,angle,run_id,
        min(confirmed_at) AS started_at,max(confirmed_at) AS last_at
      FROM numbered GROUP BY board_id,reporter,board_type,climb_uuid,angle,run_id
    ), timed AS (
      SELECT *,lead(started_at) OVER (PARTITION BY board_id,reporter ORDER BY started_at,run_id) AS next_at FROM runs
    ), totals AS MATERIALIZED (
      SELECT board_type,climb_uuid,angle,count(*) AS plays FROM timed
      WHERE next_at-started_at >= interval '30 seconds' AND next_at-last_at <= interval '30 minutes'
      GROUP BY board_type,climb_uuid,angle
    ), candidates AS (
      SELECT t.board_type,t.climb_uuid,t.angle,t.plays,s.play_count AS previous_count,s.climb_uuid IS NOT NULL AS matched
      FROM totals t LEFT JOIN board_climb_stats s USING(board_type,climb_uuid,angle)
      UNION ALL
      SELECT s.board_type,s.climb_uuid,s.angle,0 AS plays,s.play_count AS previous_count,true AS matched
      FROM board_climb_stats s WHERE s.play_count>0
        AND NOT EXISTS (SELECT 1 FROM totals t WHERE t.board_type=s.board_type AND t.climb_uuid=s.climb_uuid AND t.angle=s.angle)
    )
    SELECT json_build_object(
      'changes',coalesce((SELECT json_agg(json_build_object('boardType',board_type,'climbUuid',climb_uuid,'angle',angle,'playCount',plays)
        ORDER BY board_type,climb_uuid,angle) FROM candidates WHERE matched AND previous_count IS DISTINCT FROM plays),'[]'::json),
      'qualifyingPlays',coalesce((SELECT sum(plays) FROM totals),0),
      'unmatchedKeys',(SELECT count(*) FROM candidates WHERE NOT matched),
      'unmatchedPlays',coalesce((SELECT sum(plays) FROM candidates WHERE NOT matched),0),
      'excludedRecords',(SELECT count(*) FROM classified WHERE excluded OR (shared AND user_id IS NULL)),
      'measuredAt',statement_timestamp()::text
    ) AS plan
  `);
  // Reject malformed/failed reads; never turn them into an empty rebuild.
  return z
    .array(z.object({ plan: planSchema }))
    .length(1)
    .parse(result)[0].plan;
}

export async function applyClimbPlaysBatch(
  database: PlaysDatabase,
  changes: PlaysRefreshPlan['changes'],
): Promise<number> {
  if (changes.length === 0) return 0;
  if (changes.length > PLAY_REFRESH_BATCH_SIZE) throw new Error('PLAY_REFRESH_BATCH_TOO_LARGE');
  const rows = sql.join(
    changes.map(
      (change) =>
        sql`(${change.boardType}::text,${change.climbUuid}::text,${change.angle}::int,${change.playCount}::bigint)`,
    ),
    sql`, `,
  );
  const result = await database.execute(sql`
    UPDATE board_climb_stats s SET play_count=desired.plays
    FROM (VALUES ${rows}) AS desired(board_type,climb_uuid,angle,plays)
    WHERE s.board_type=desired.board_type AND s.climb_uuid=desired.climb_uuid AND s.angle=desired.angle
      AND s.play_count IS DISTINCT FROM desired.plays
    RETURNING s.climb_uuid
  `);
  if (!Array.isArray(result)) throw new Error('INVALID_PLAY_REFRESH_RESULT');
  return result.length;
}
