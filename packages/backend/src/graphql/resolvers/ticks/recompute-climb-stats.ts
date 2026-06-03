import { sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * Recompute board_climb_stats for a single (boardType, climbUuid, angle)
 * from the boardsesh_ticks table. Driven by the debounced publisher in
 * debounced-climb-stats-publisher.ts.
 *
 * What this writes:
 *   - boardsesh_ascensionist_count = COUNT(DISTINCT user_id) over flash/send ticks
 *   - ascensionist_count = COALESCE(kilter_ascensionist_count, aurora_ascensionist_count, 0)
 *                         + COALESCE(boardsesh_ascensionist_count, 0)
 *     (the materialized count the search hot path reads through the covering
 *     index from migration 0067)
 *
 *     aurora_ and kilter_ are NOT summed: for the Kilter board they are the
 *     SAME ascents from two backends (the pre-split kilterboardapp.com vs
 *     kiltergrips.com — Kilter migrated the logs, so the counts match within
 *     snapshot noise; summing would double them). Kilter (the live source)
 *     wins; aurora is a fallback for climbs Kilter Grips no longer carries.
 *     For boards with only one source (e.g. Tension) the other column is NULL
 *     so COALESCE collapses to that single value — behaviour is unchanged.
 *   - fa_username / fa_at:
 *       For Boardsesh-originated climbs (board_climbs.user_id IS NOT NULL),
 *       Boardsesh owns the FA — we re-derive it from the current ticks so a
 *       deleted/downgraded FA tick correctly demotes to the next earliest
 *       sender (or to NULL if no senders remain).
 *
 *       For Aurora-synced climbs, Aurora's FA is authoritative. We keep the
 *       existing value and only fill it from ticks if Aurora hasn't supplied
 *       one yet (COALESCE on the Aurora-side branch).
 *
 *       If we can't determine ownership (no matching board_climbs row, which
 *       can happen during sync), default to the conservative branch and
 *       preserve any existing FA.
 *   - quality_average / difficulty_average / display_difficulty:
 *       Same ownership rule as FA. For Boardsesh-originated climbs we
 *       recompute the averages from the current set of flash/send ticks
 *       (Postgres AVG skips NULL inputs, so a single rated tick is enough
 *       to populate a column; deleting every rated tick reverts the column
 *       to NULL). For Aurora-synced climbs we leave the columns alone —
 *       Aurora's upsertClimbStats clobbers them on every sync, and Aurora's
 *       population averages are far better than a handful of Boardsesh
 *       ticks. display_difficulty mirrors difficulty_average, matching
 *       Aurora's own derivation in upsertClimbStats.
 *
 * INSERT + UPDATE are wrapped in a single transaction so a row never exists
 * in the half-state where ascensionist_count = 0 is visible.
 *
 * Defensive insert: if the stats row doesn't exist at this angle (shouldn't
 * happen after the saveClimb stats seed, but ticks can theoretically arrive at
 * angles the seed didn't cover), insert a minimal row first so the subsequent
 * UPDATE has something to touch.
 */
export async function recomputeClimbStats(boardType: string, climbUuid: string, angle: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Defensive seed: set aurora_/kilter_ascensionist_count to 0 explicitly so
    // the subsequent recompute (COALESCE(kilter, aurora, 0) + boardsesh) and any
    // later Aurora/Kilter upsert both see a sensible baseline. Without it,
    // freshly seeded rows would carry NULL counts until those syncs first ran.
    await tx
      .insert(dbSchema.boardClimbStats)
      .values({
        boardType,
        climbUuid,
        angle,
        ascensionistCount: 0,
        auroraAscensionistCount: 0,
        kilterAscensionistCount: 0,
        boardseshAscensionistCount: 0,
      })
      .onConflictDoNothing({
        target: [
          dbSchema.boardClimbStats.boardType,
          dbSchema.boardClimbStats.climbUuid,
          dbSchema.boardClimbStats.angle,
        ],
      });

    await tx.execute(sql`
      WITH agg AS (
        SELECT
          COUNT(DISTINCT bt.user_id) AS distinct_senders,
          MIN(bt.climbed_at)         AS first_at,
          AVG(bt.quality)            AS avg_quality,
          AVG(bt.difficulty)         AS avg_difficulty,
          (SELECT COALESCE(up.display_name, u.name)
             FROM boardsesh_ticks bt2
             JOIN users            u  ON u.id      = bt2.user_id
        LEFT JOIN user_profiles    up ON up.user_id = u.id
            WHERE bt2.board_type = ${boardType}
              AND bt2.climb_uuid = ${climbUuid}
              AND bt2.angle      = ${angle}
              AND bt2.status IN ('flash','send')
            ORDER BY bt2.climbed_at ASC
            LIMIT 1)                  AS first_user
        FROM boardsesh_ticks bt
        WHERE bt.board_type = ${boardType}
          AND bt.climb_uuid = ${climbUuid}
          AND bt.angle      = ${angle}
          AND bt.status IN ('flash','send')
      ),
      owner AS (
        SELECT bc.user_id IS NOT NULL AS boardsesh_owned
          FROM board_climbs bc
         WHERE bc.board_type = ${boardType}
           AND bc.uuid       = ${climbUuid}
      )
      UPDATE board_climb_stats s
         SET boardsesh_ascensionist_count = COALESCE(agg.distinct_senders, 0),
             ascensionist_count           = COALESCE(s.kilter_ascensionist_count, s.aurora_ascensionist_count, 0)
                                          + COALESCE(agg.distinct_senders, 0),
             fa_username = CASE
               WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                 THEN agg.first_user
               ELSE COALESCE(s.fa_username, agg.first_user)
             END,
             fa_at = CASE
               WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                 THEN agg.first_at
               ELSE COALESCE(s.fa_at, agg.first_at)
             END,
             quality_average = CASE
               WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                 THEN agg.avg_quality
               ELSE s.quality_average
             END,
             difficulty_average = CASE
               WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                 THEN agg.avg_difficulty
               ELSE s.difficulty_average
             END,
             display_difficulty = CASE
               WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                 THEN agg.avg_difficulty
               ELSE s.display_difficulty
             END
        FROM agg
       WHERE s.board_type = ${boardType}
         AND s.climb_uuid = ${climbUuid}
         AND s.angle      = ${angle};
    `);
  });
}
