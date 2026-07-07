import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbStats } from '../../schema/boards/unified';
import { rowsOf } from '../util/rows';

// Any drizzle-orm PgDatabase (postgres-js client, the script client, the
// Neon HTTP client the web app uses) and the PgTransaction handle backend
// resolvers run inside all satisfy this — they share the full PgDatabase
// query surface, so callers get real type checking without a cast.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Recompute board_climb_stats from boardsesh_ticks — the single source of the
 * ascensionist / FA / difficulty logic shared by the backend saveTick path
 * (single key, debounced) and the sync daemons + backfill (bulk, set-based).
 *
 * The counting rule (the whole point of the ascent double-count fix):
 *
 *   boardsesh_ascensionist_count = number of DISTINCT users who have ≥1
 *   flash/send tick at the (board, climb, angle) key AND have NO tick at that
 *   key with origin != 'native'.
 *
 * A user with any imported tick (aurora_pull / kilter_pull / json_import) at
 * the key is already inside upstream_ascensionist_count, so counting their
 * Boardsesh tick again would double-count the ascent — they contribute 0. A
 * user whose ticks at the key are ALL native (including a native tick that
 * later had kilter_id stamped by push-back) counts. This is a per-user
 * `bool_or(origin <> 'native')` grouping.
 *
 * ascensionist_count stays the materialized sum:
 *   COALESCE(upstream_ascensionist_count, 0) + boardsesh_ascensionist_count.
 * Boardsesh ticks ADD to the single upstream (manufacturer) count; they never
 * replace it.
 *
 * FA (fa_username / fa_at):
 *   - Boardsesh-owned climbs (board_climbs.user_id IS NOT NULL): re-derive from
 *     the earliest flash/send tick of ANY origin, every pass (a deleted/
 *     downgraded FA tick demotes to the next sender or NULL).
 *   - Non-owned climbs (user_id IS NULL / no row): the manufacturer owns the
 *     authoritative FA and the recompute NEVER derives or fills it from ticks —
 *     the stored value is preserved verbatim. A Boardsesh tick (native OR
 *     imported) must never crown a manufacturer climb the user merely logged.
 *     Boards whose upstream supplies no FA (MoonBoard) correctly stay NULL; the
 *     upstream syncs re-fill the authoritative FA on Kilter/Tension on their
 *     next pass. (The one-time 0157 backfill clears the pre-existing
 *     tick-derived crowns this rule used to allow.)
 *
 * quality_average / difficulty_average / display_difficulty: recomputed from
 * flash/send ticks on OWNED climbs only (upstream owns them on synced climbs).
 * quality = 0 is a legacy sentinel — excluded from AVG(quality) via NULLIF.
 */

export type DiffRow = {
  prev_bs: number | string | null;
  prev_total: number | string | null;
  prev_fa: string | null;
  new_bs: number | string | null;
  new_total: number | string | null;
  new_fa: string | null;
};

export type ClimbStatsKey = {
  boardType: string;
  climbUuid: string;
  angle: number;
};

// Keep bulk statements well under Postgres's parameter ceiling and bound the
// per-statement working set the aggregate CTEs scan.
const BULK_CHUNK_SIZE = 500;

/**
 * Recompute a single (boardType, climbUuid, angle) inside one transaction and
 * return the prev → new diff (Boardsesh count, total, FA) for the caller to
 * log. Defensive seed first so the subsequent UPDATE always has a row to touch.
 * Returns undefined when the UPDATE matched no row.
 */
export async function recomputeClimbStats(
  db: DrizzleDb,
  boardType: string,
  climbUuid: string,
  angle: number,
): Promise<DiffRow | undefined> {
  let diff: DiffRow | undefined;

  await db.transaction(async (tx) => {
    // Defensive seed: set upstream/boardsesh counts to 0 explicitly so the
    // recompute and any later upstream sync both see a sensible baseline.
    await tx
      .insert(boardClimbStats)
      .values({
        boardType,
        climbUuid,
        angle,
        ascensionistCount: 0,
        upstreamAscensionistCount: 0,
        boardseshAscensionistCount: 0,
      })
      .onConflictDoNothing({
        target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
      });

    const result = await tx.execute(sql`
      WITH before AS (
        SELECT boardsesh_ascensionist_count AS prev_bs,
               ascensionist_count           AS prev_total,
               fa_username                  AS prev_fa
          FROM board_climb_stats
         WHERE board_type = ${boardType}
           AND climb_uuid = ${climbUuid}
           AND angle      = ${angle}
      ),
      agg AS (
        SELECT
          -- Per-user double-count guard: a user counts only when they have a
          -- flash/send tick AND none of their flash/send ticks at the key are
          -- imported. Imported ATTEMPTS don't disqualify — upstream ascent
          -- counts only include sends/logs, so an imported bid never puts the
          -- user in the upstream number.
          (SELECT COUNT(*) FROM (
              SELECT bt_u.user_id
                FROM boardsesh_ticks bt_u
               WHERE bt_u.board_type = ${boardType}
                 AND bt_u.climb_uuid = ${climbUuid}
                 AND bt_u.angle      = ${angle}
               GROUP BY bt_u.user_id
              HAVING bool_or(bt_u.status IN ('flash','send'))
                 AND NOT bool_or(bt_u.origin <> 'native' AND bt_u.status IN ('flash','send'))
            ) counting_users)          AS distinct_senders,
          MIN(bt.climbed_at)           AS first_at,
          -- Deliberately NOT origin-filtered: these averages are only ever
          -- written to boardsesh-OWNED climbs (see the ownership CASE below),
          -- which have no upstream average to double-count against — so every
          -- rating on the climb contributes, wherever the tick later synced.
          AVG(NULLIF(bt.quality, 0))   AS avg_quality,
          AVG(bt.difficulty)           AS avg_difficulty,
          (SELECT COALESCE(up.display_name, u.name)
             FROM boardsesh_ticks bt2
             JOIN users            u  ON u.id      = bt2.user_id
        LEFT JOIN user_profiles    up ON up.user_id = u.id
            WHERE bt2.board_type = ${boardType}
              AND bt2.climb_uuid = ${climbUuid}
              AND bt2.angle      = ${angle}
              AND bt2.status IN ('flash','send')
            ORDER BY bt2.climbed_at ASC
            LIMIT 1)                   AS first_user
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
      ),
      updated AS (
        UPDATE board_climb_stats s
           SET boardsesh_ascensionist_count = COALESCE(agg.distinct_senders, 0),
               ascensionist_count           = COALESCE(s.upstream_ascensionist_count, 0)
                                            + COALESCE(agg.distinct_senders, 0),
               fa_username = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN agg.first_user
                 ELSE s.fa_username
               END,
               fa_at = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN agg.first_at
                 ELSE s.fa_at
               END,
               quality_average = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN agg.avg_quality
                 ELSE s.quality_average
               END,
               quality_normalized = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN TRUE
                 ELSE s.quality_normalized
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
           AND s.angle      = ${angle}
        RETURNING boardsesh_ascensionist_count AS new_bs,
                  ascensionist_count           AS new_total,
                  fa_username                  AS new_fa
      )
      SELECT before.prev_bs, before.prev_total, before.prev_fa,
             updated.new_bs, updated.new_total, updated.new_fa
        FROM before, updated;
    `);

    const rows = rowsOf<DiffRow>(result);
    if (rows.length > 0) {
      diff = rows[0];
    }
  });

  return diff;
}

function dedupeKeys(keys: ClimbStatsKey[]): ClimbStatsKey[] {
  const seen = new Map<string, ClimbStatsKey>();
  for (const key of keys) {
    seen.set(`${key.boardType} ${key.climbUuid} ${key.angle}`, key);
  }
  return [...seen.values()];
}

/**
 * Recompute many keys with the same rules as recomputeClimbStats, set-based:
 * one seed INSERT + one aggregate UPDATE per chunk of ≤500 keys. No diff/log —
 * used by the sync daemons and the backfill where per-key logging would be
 * noise. Callers pass the DISTINCT keys of the flash/send ticks they wrote.
 *
 * Idempotent: safe to call on a passed transaction (the writer's tx) or a
 * top-level db. Does not open its own transaction — the seed + update are
 * individually idempotent, so a re-run repairs any partial state.
 *
 * Offline propagation: the UPDATE below is a plain SQL UPDATE, so every row
 * whose values actually change fires the BEFORE UPDATE trigger
 * trg_board_climb_stats_set_sync_fields (migration 0144, WHEN-guarded on
 * OLD.* IS DISTINCT FROM NEW.* in 0146), which stamps updated_at = now() and
 * sync_seq = nextval(). The offline pull cursor for board_climb_stats is
 * exactly (updated_at, sync_seq) (backend syncClimbStats), so the recomputed
 * counts reach mobile offline clients automatically, bounded to changed rows —
 * a no-op recompute (values unchanged) doesn't fire the trigger and isn't
 * re-shipped. The single-key recomputeClimbStats path propagates the same way.
 * Do NOT stamp updated_at/sync_seq here manually — the trigger is the single
 * mechanism the whole system relies on.
 */
export async function recomputeClimbStatsBulk(db: DrizzleDb, keys: ClimbStatsKey[]): Promise<void> {
  const distinct = dedupeKeys(keys);
  if (distinct.length === 0) return;

  for (let i = 0; i < distinct.length; i += BULK_CHUNK_SIZE) {
    const chunk = distinct.slice(i, i + BULK_CHUNK_SIZE);
    const payload = JSON.stringify(
      chunk.map((key) => ({ board_type: key.boardType, climb_uuid: key.climbUuid, angle: key.angle })),
    );

    // Defensive seed for keys whose stats row doesn't exist yet (ticks can
    // arrive at angles the saveClimb seed didn't cover).
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle,
                                     ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count)
      SELECT k.board_type, k.climb_uuid, k.angle, 0, 0, 0
        FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING;
    `);

    await db.execute(sql`
      WITH keys AS (
        SELECT board_type, climb_uuid, angle
          FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ),
      per_user AS (
        SELECT bt.board_type, bt.climb_uuid, bt.angle, bt.user_id,
               bool_or(bt.status IN ('flash','send')) AS has_send,
               -- Only imported FLASH/SEND ticks mark a user as upstream-
               -- represented: upstream ascent counts don't include bids, so an
               -- imported attempt must not disqualify a native send.
               bool_or(bt.origin <> 'native' AND bt.status IN ('flash','send')) AS has_upstream
          FROM boardsesh_ticks bt
          JOIN keys k
            ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
         GROUP BY bt.board_type, bt.climb_uuid, bt.angle, bt.user_id
      ),
      counts AS (
        SELECT board_type, climb_uuid, angle,
               COUNT(*) FILTER (WHERE has_send AND NOT has_upstream) AS distinct_senders
          FROM per_user
         GROUP BY board_type, climb_uuid, angle
      ),
      sends AS (
        SELECT bt.board_type, bt.climb_uuid, bt.angle,
               MIN(bt.climbed_at)                                     AS first_at,
               AVG(NULLIF(bt.quality, 0))                             AS avg_quality,
               AVG(bt.difficulty)                                     AS avg_difficulty
          FROM boardsesh_ticks bt
          JOIN keys k
            ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
         WHERE bt.status IN ('flash','send')
         GROUP BY bt.board_type, bt.climb_uuid, bt.angle
      ),
      first_user AS (
        SELECT DISTINCT ON (bt.board_type, bt.climb_uuid, bt.angle)
               bt.board_type, bt.climb_uuid, bt.angle,
               COALESCE(up.display_name, u.name) AS crown
          FROM boardsesh_ticks bt
          JOIN keys k
            ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
          JOIN users u ON u.id = bt.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE bt.status IN ('flash','send')
         ORDER BY bt.board_type, bt.climb_uuid, bt.angle, bt.climbed_at ASC
      )
      UPDATE board_climb_stats s
         SET boardsesh_ascensionist_count = COALESCE(c.distinct_senders, 0),
             ascensionist_count           = COALESCE(s.upstream_ascensionist_count, 0)
                                          + COALESCE(c.distinct_senders, 0),
             -- Owned climbs re-derive FA from the earliest tick; non-owned
             -- climbs preserve the manufacturer's stored FA verbatim (never
             -- derived or filled from ticks — see the module doc).
             fa_username = CASE WHEN owned.boardsesh_owned
                                  THEN fu.crown
                                  ELSE s.fa_username END,
             fa_at       = CASE WHEN owned.boardsesh_owned
                                  THEN sd.first_at
                                  ELSE s.fa_at END,
             quality_average    = CASE WHEN owned.boardsesh_owned THEN sd.avg_quality    ELSE s.quality_average END,
             quality_normalized = CASE WHEN owned.boardsesh_owned THEN TRUE              ELSE s.quality_normalized END,
             difficulty_average = CASE WHEN owned.boardsesh_owned THEN sd.avg_difficulty ELSE s.difficulty_average END,
             display_difficulty = CASE WHEN owned.boardsesh_owned THEN sd.avg_difficulty ELSE s.display_difficulty END
        FROM keys k
        LEFT JOIN counts c
          ON c.board_type = k.board_type AND c.climb_uuid = k.climb_uuid AND c.angle = k.angle
        LEFT JOIN sends sd
          ON sd.board_type = k.board_type AND sd.climb_uuid = k.climb_uuid AND sd.angle = k.angle
        LEFT JOIN first_user fu
          ON fu.board_type = k.board_type AND fu.climb_uuid = k.climb_uuid AND fu.angle = k.angle
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   (SELECT bc.user_id IS NOT NULL
                      FROM board_climbs bc
                     WHERE bc.board_type = k.board_type AND bc.uuid = k.climb_uuid),
                   FALSE) AS boardsesh_owned
        ) owned ON TRUE
       WHERE s.board_type = k.board_type
         AND s.climb_uuid = k.climb_uuid
         AND s.angle      = k.angle;
    `);
  }
}
