import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { rowsOf } from '../util/rows';
import { setSerialPlan } from '../util/serial-plan';
import { blendedQualityAverageSql } from './quality-blend';
import { deriveGradeFromTicksSql, statsRowCarriesRealCatalogDataSql } from './real-catalog-data';

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
 *   UNABSORBED native flash/send tick at the (board, climb, angle) key AND
 *   have NO flash/send tick at that key with origin != 'native'.
 *
 * A user with any imported flash/send tick (aurora_pull / kilter_pull /
 * json_import) at the key is already inside upstream_ascensionist_count, so
 * counting their Boardsesh tick again would double-count the ascent — they
 * contribute 0.
 *
 * Absorption (the push-back double-count guard): a native tick that push-back
 * sent to Kilter (kilter_id set) keeps counting immediately, but ONLY until the
 * upstream snapshot has plausibly re-counted it — kilter_synced_at <
 * board_climb_stats.upstream_synced_at - 48h. Past that window the tick is
 * "absorbed" into the upstream count, so a user whose ONLY native flash/send
 * ticks at the key are absorbed stops contributing (else double-count). A fresh
 * push (within 48h, or synced after the last upstream sync) still counts — the
 * locked product requirement. Keys never upstream-synced (upstream_synced_at
 * NULL: MoonBoard, Boardsesh-owned) are never absorbed. This is a per-user
 * `bool_or(unabsorbed native send) AND NOT bool_or(imported send)` grouping.
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
 * difficulty_average / display_difficulty / tick_graded_at: recomputed from
 * flash/send ticks when EITHER the climb is Boardsesh-owned OR the row's grade
 * is ours to write — deriveGradeFromTicksSql (real-catalog-data.ts): not
 * MoonBoard, and either the row has no display_difficulty at all or we graded it
 * (tick_graded_at set) and no upstream writer has stamped upstream_synced_at
 * since. tick_graded_at is stamped `now() AT TIME ZONE 'UTC'` on every derive
 * that produces a grade, and cleared to NULL when the last graded tick
 * disappears. The explicit UTC matters: upstream_synced_at is written as a JS
 * ISO string (UTC wall time) into a zoneless column, so a bare now() would
 * compare a session-local wall time against a UTC one.
 *
 * Why not "owned only" (#4798). A Woods catalog climb is imported with
 * user_id NULL and ONE graded stats row, at the set angle. Ticked at a new
 * angle it seeds a row there, and the owned-only rule left that row's
 * display_difficulty NULL forever — so the climb never appeared under a grade
 * at the angle people actually climbed it. Same latent gap on any Kilter /
 * Tension key with no Aurora row.
 *
 * Why MoonBoard is fenced out of the non-owned legs. Ungraded MoonBoard catalog
 * rows are legitimate, and two scripts fill them from the Moon catalog under a
 * `display_difficulty IS NULL` guard (packages/db/scripts/moonboard-grade-repair.ts,
 * packages/db/scripts/repair-moonboard-8c-grades.ts). Tick-grading such a row
 * would make both skip it forever and would flip statsRowCarriesRealCatalogData
 * — the predicate the whole #3529 wrong-angle fix hangs on — TRUE on a row that
 * holds no catalog data. Owned MoonBoard climbs still derive: nothing repairs a
 * climber's own problem from the Moon catalog.
 *
 * Why the marker column rather than "unstamped means ours". Prod has 12 Kilter
 * and 2 Tension non-owned GRADED rows with no upstream_synced_at at all, plus
 * 134k unstamped graded Tension rows — so "no stamp" cannot be read as "we
 * wrote it". A graded row with tick_graded_at NULL is therefore always
 * upstream's and is left alone.
 *
 * Why almost no upstream writer needs to know about the column. Aurora
 * shared-sync, kilter-sync catalog-sync and stats-repair, and the Woods importer
 * already stamp upstream_synced_at on insert AND on conflict. So the moment
 * upstream grades a key, its stamp is newer than our tick_graded_at,
 * deriveGradeFromTicksSql goes false, and the recompute stops writing that row's
 * grade — with no edit to those writers. One exception had to be fixed:
 * packages/db/scripts/import-aurora-board-unified.ts (decoy / touchstone /
 * grasshopper / soill) wrote display_difficulty with no stamp at all, so its
 * grades read as nobody's; it now stamps upstreamSyncedAt like the rest. The
 * MoonBoard importers and grade-repair scripts need no stamp — the MoonBoard
 * fence above keeps the recompute off their rows entirely.
 *
 * One accepted edge: the Aurora shared-sync upsert sets
 * display_difficulty = excluded.display_difficulty, so an EMPTY upstream grade
 * wipes a grade we derived; the row then reads display_difficulty NULL and the
 * next recompute re-derives it. kilter-sync COALESCEs instead and keeps ours.
 *
 * quality_average is the materialized BLEND of the upstream quality average and
 * Boardsesh's native ratings (blendedQualityAverageSql, quality-blend.ts) — the
 * mirror of how ascensionist_count blends upstream + Boardsesh counts:
 *   - OWNED climbs (board_climbs.user_id NOT NULL): no upstream side, so
 *     quality_average stays a plain AVG(quality) FILTER (WHERE quality BETWEEN
 *     1 AND 5) over ALL flash/send ticks of any origin.
 *   - NON-owned climbs: quality_average = blend(upstream_quality_average,
 *     upstream_ascensionist_count, boardsesh_quality_sum, boardsesh_quality_count),
 *     rewritten in the SAME statement that recomputes the Boardsesh terms.
 *
 * The recompute OWNS boardsesh_quality_sum / boardsesh_quality_count (the blend's
 * Boardsesh side), computed as one vote per climber: each climber's LATEST rated
 * native flash/send tick (max climbed_at, tie-break max id) with quality 1..5 and
 * origin = 'native', excluding detached ticks. A climber re-ticking the same
 * climb does NOT multiply their vote — only their latest attached rating counts.
 * Imported ratings (aurora_pull / kilter_pull / json_import) are already reflected
 * in upstream_quality_average and are deliberately excluded here so they are not
 * double-counted. The recompute never writes upstream_quality_average (the upstream
 * syncs own it).
 *
 * The defensive seed is GUARDED on the climb existing in board_climbs (#3528)
 * AND a matching non-detached flash/send tick still existing at the key.
 * A tick can carry any string as its climb_uuid — saveTick's Zod schema is
 * shape-only and boardsesh_ticks has no FK to board_climbs — so an unguarded
 * seed minted a permanent board_climb_stats row for whatever key a tick landed
 * on, and the non-owned branch below then wrote real counts into it (77 such
 * orphan rows in prod). Both seeds now insert only when board_climbs has a row
 * for (board_type, climb_uuid); the lookup rides board_climbs_pkey.
 *
 * The tick-existence guard applies ONLY to INSERT. The UPDATE always receives
 * every requested key so deleting/detaching/downgrading the final send clears
 * an existing row's Boardsesh-owned aggregates while preserving its upstream
 * fields. A matching send at a new angle remains legitimate and seeds a row.
 *
 * That seed is deliberately guarded on the CLIMB, not on (climb, angle): a tick
 * at an angle the catalog has no stats row for is legitimate and must still seed
 * — that is the whole reason the seed exists. Tightening this to (climb, angle)
 * would break real ticks, and there is a test whose only job is to fail if you do.
 *
 * ONE narrow exception, MoonBoard only (#3529). MoonBoard identity is
 * angle-bearing: the catalog importer mints one board_climbs row per (problem,
 * angle) as uuidv5('moonboard:{id}:{angle}'), each with a non-null
 * board_climbs.angle. A tick logged from a board set to the OTHER angle therefore
 * names a climb that is not graded at the tick's angle, and seeding there mints a
 * row nothing can render: it shows up in that angle's stats-driven search with a
 * NULL grade and a 1-ascent count, while the send is missing from the page every
 * other climber browses. So the seed skips when ALL of:
 *   - board_type = 'moonboard'  (Kilter/Tension are byte-for-byte unaffected —
 *     their catalog grades every angle independently)
 *   - board_climbs.user_id IS NULL — CATALOG climbs only, the same fence
 *     resolveMoonBoardTickAngle and the moonboard_wrong_angle_stats_cleanup migration carry. Nothing grades a
 *     climber's own problem per angle, so a tick at any angle on one is
 *     legitimate and must still seed
 *   - board_climbs.angle IS NOT NULL and differs from the tick's angle
 *   - no stats row carrying REAL CATALOG DATA exists at the tick's angle
 *     (statsRowCarriesRealCatalogData — the shared predicate; bare existence
 *     would be useless here, since the phantom row IS the thing being described)
 * which is exactly the condition under which resolveMoonBoardTickAngle would
 * have snapped the tick in the first place. This layer is the defence in depth
 * for ticks that did NOT go through saveTick: rows written before the fix
 * shipped, bulk/self-heal recomputes over them, and any future importer. (It is
 * NOT about the legacy web proxy — that route returns 400 for MoonBoard and can
 * never write a MoonBoard tick.)
 *
 * The exception does NOT retire itself when #3851's angle-agnostic import lands.
 * #3851 sets board_climbs.angle = NULL only on the rows it INSERTS; its upsert
 * set-list on board_climbs carries characteristics and description, not angle,
 * and it ships no migration — so a re-import leaves existing canonical rows at
 * the angle they already have and this guard keeps firing on them. Removing it
 * is a deliberate edit here and in resolveMoonBoardTickAngle (and a migration,
 * if the canonical angles are ever to go null). See the fuller forward-compat
 * note on resolveMoonBoardTickAngle, including the #3849 window and the #3852
 * interaction.
 *
 * Seeded rows carry quality_normalized = TRUE. Every value the row can ever
 * hold is on the canonical 1-5 scale: the Boardsesh blend is built from native
 * ticks (validated 1-5), and the only writers of the upstream side (Aurora
 * shared-sync, Kilter catalog-sync / stats-repair, the MoonBoard importers) all
 * set the flag TRUE on insert AND on conflict. Leaving it at the column default
 * FALSE is what stranded a growing set of MoonBoard rows outside the "all
 * normalized" invariant (#3529, seed half — 44 at the audit, 101 by the time
 * the moonboard_wrong_angle_stats_cleanup migration backfilled them).
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

  // Non-owned quality blend: stored upstream terms + the freshly aggregated
  // Boardsesh vote. s.upstream_* are the OLD/current row values (recompute never
  // changes them), so the bare column reference is correct here.
  const singleKeyBlend = blendedQualityAverageSql({
    upstreamQualityAverage: sql`s.upstream_quality_average`,
    upstreamAscensionistCount: sql`s.upstream_ascensionist_count`,
    boardseshQualitySum: sql`bq.bs_quality_sum`,
    boardseshQualityCount: sql`bq.bs_quality_count`,
  });

  await db.transaction(async (tx) => {
    // The aggregate UPDATE below hash-joins boardsesh_ticks against
    // board_climb_stats, which is exactly the plan shape that exhausts
    // Postgres's dynamic shared memory on our small /dev/shm (pgCode 53100 —
    // Sentry BOARDSESH-B6, issue #4235). Set the GUC on the transaction we
    // already own; `withSerialPlan` here would open a savepoint just to run one
    // SET LOCAL.
    await setSerialPlan(tx);

    // Defensive seed: set upstream/boardsesh counts to 0 explicitly so the
    // recompute and any later upstream sync both see a sensible baseline.
    //
    // INSERT ... SELECT FROM board_climbs makes the catalog lookup one guard;
    // the correlated tick EXISTS is the second. The SELECT yields exactly one
    // row only for a real climb with a matching attached flash/send. When
    // nothing is seeded the UPDATE below still runs, so an existing row can be
    // cleared after its final send disappears; a never-seeded key simply
    // matches no row and this function returns undefined.
    //
    // Raw SQL rather than the drizzle insert builder, and not for lack of
    // trying: `.values()` cannot carry a WHERE at all, and `.insert().select()`
    // throws at runtime on a partial column list ("selected fields are not the
    // same or are in a different order compared to the table definition"), so
    // it would force us to enumerate every column of board_climb_stats and
    // re-enumerate them on every future column addition.
    //
    // The catalog-existence guard is the same statement shape as the bulk seed
    // below, deliberately — those two should diff clean. The MoonBoard
    // wrong-angle guard (#3529) cannot: here board_climbs is in the outer FROM
    // so bc.angle is directly in scope, whereas the bulk seed only reaches
    // board_climbs inside an EXISTS and has to carry the angle test in there.
    // Same predicate, two shapes; contorting either to match the other would
    // cost more clarity than the diff-cleanliness buys.
    //
    // `bc.user_id IS NOT NULL` short-circuits the guard for USER-CREATED climbs,
    // matching both resolveMoonBoardTickAngle and the moonboard_wrong_angle_stats_cleanup migration's `bc.user_id
    // IS NULL` fence: editClimb leaves a stats row behind at the old angle by
    // design, so a tick at that angle is legitimate and must still seed.
    await tx.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle,
                                     ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count,
                                     quality_normalized)
      SELECT ${boardType}::text, ${climbUuid}::text, ${angle}::integer, 0, 0, 0, TRUE
        FROM board_climbs bc
       WHERE bc.uuid = ${climbUuid}
         AND bc.board_type = ${boardType}
         AND EXISTS (
           SELECT 1
             FROM boardsesh_ticks seed_tick
            WHERE seed_tick.board_type = ${boardType}
              AND seed_tick.climb_uuid = ${climbUuid}
              AND seed_tick.angle = ${angle}
              AND seed_tick.status IN ('flash','send')
              AND seed_tick.kilter_detached_at IS NULL
         )
         AND (
           ${boardType} <> 'moonboard'
           OR bc.user_id IS NOT NULL
           OR bc.angle IS NULL
           OR bc.angle = ${angle}
           OR EXISTS (
             SELECT 1
               FROM board_climb_stats s
              WHERE s.board_type = ${boardType}
                AND s.climb_uuid = ${climbUuid}
                AND s.angle      = ${angle}
                AND ${statsRowCarriesRealCatalogDataSql('s')}
           )
         )
      ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING;
    `);

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
      stat AS (
        SELECT upstream_synced_at
          FROM board_climb_stats
         WHERE board_type = ${boardType}
           AND climb_uuid = ${climbUuid}
           AND angle      = ${angle}
      ),
      agg AS (
        SELECT
          -- Per-user double-count guard: a user counts only when they have an
          -- UNABSORBED native flash/send tick AND none of their flash/send
          -- ticks at the key are imported. Imported ATTEMPTS don't disqualify:
          -- upstream ascent counts only include sends/logs, so an imported bid
          -- never puts the user in the upstream number.
          --
          -- Absorption (push-back double-count guard): a native tick pushed to
          -- Kilter (kilter_id set) long enough ago that the upstream snapshot
          -- has plausibly re-counted it (kilter_synced_at < upstream_synced_at
          -- - 48h) is dropped from the Boardsesh count — the user is now inside
          -- upstream_ascensionist_count via that push, so counting the native
          -- tick too would double-count. A user whose ONLY native sends are
          -- absorbed stops counting; a fresh push (synced within 48h, or after
          -- upstream) keeps counting immediately (locked product requirement).
          -- upstream_synced_at NULL (never upstream-synced: MoonBoard,
          -- Boardsesh-owned) is never absorbed, so those keep counting.
          (SELECT COUNT(*) FROM (
              SELECT bt_u.user_id
                FROM boardsesh_ticks bt_u
               WHERE bt_u.board_type = ${boardType}
                 AND bt_u.climb_uuid = ${climbUuid}
                 AND bt_u.angle      = ${angle}
                 AND bt_u.kilter_detached_at IS NULL
               GROUP BY bt_u.user_id
              HAVING bool_or(
                       bt_u.origin = 'native' AND bt_u.status IN ('flash','send')
                       AND NOT (
                         bt_u.kilter_id IS NOT NULL
                         AND bt_u.kilter_synced_at IS NOT NULL
                         AND (SELECT upstream_synced_at FROM stat) IS NOT NULL
                         AND bt_u.kilter_synced_at < (SELECT upstream_synced_at FROM stat) - interval '48 hours'
                       )
                     )
                 AND NOT bool_or(bt_u.origin <> 'native' AND bt_u.status IN ('flash','send'))
            ) counting_users)          AS distinct_senders,
          MIN(bt.climbed_at)           AS first_at,
          -- Deliberately NOT origin-filtered, and safe for both consumers:
          --   avg_quality is only ever written to boardsesh-OWNED climbs (see
          --   the ownership CASE below), which have no upstream average to
          --   double-count against.
          --   avg_difficulty also reaches NON-owned rows since #4798, so an
          --   imported (aurora_pull / kilter_pull / json_import) tick can feed a
          --   catalog climb's grade. That is fine for the same reason: the
          --   non-owned legs only fire when there is no upstream grade on the
          --   row, or when the grade there is one we derived — so there is never
          --   an upstream average being double-counted or overwritten.
          -- Either way every rating on the climb contributes, wherever the tick
          -- later synced.
          AVG(bt.quality) FILTER (WHERE bt.quality BETWEEN 1 AND 5) AS avg_quality,
          AVG(bt.difficulty) FILTER (WHERE bt.difficulty > 1)       AS avg_difficulty,
          (SELECT COALESCE(up.display_name, u.name)
             FROM boardsesh_ticks bt2
             JOIN users            u  ON u.id      = bt2.user_id
        LEFT JOIN user_profiles    up ON up.user_id = u.id
            WHERE bt2.board_type = ${boardType}
              AND bt2.climb_uuid = ${climbUuid}
              AND bt2.angle      = ${angle}
              AND bt2.status IN ('flash','send')
              AND bt2.kilter_detached_at IS NULL
            ORDER BY bt2.climbed_at ASC
            LIMIT 1)                   AS first_user
        FROM boardsesh_ticks bt
        WHERE bt.board_type = ${boardType}
          AND bt.climb_uuid = ${climbUuid}
          AND bt.angle      = ${angle}
          AND bt.status IN ('flash','send')
          AND bt.kilter_detached_at IS NULL
      ),
      -- The blend's Boardsesh side: one vote per climber = their LATEST rated
      -- native flash/send tick (max climbed_at, tie-break max id). origin filter
      -- keeps imported ratings out (they're already in upstream_quality_average).
      -- Always exactly one row (aggregate over a possibly-empty set).
      bs_quality AS (
        SELECT SUM(latest.quality)::double precision AS bs_quality_sum,
               COUNT(*)::bigint                      AS bs_quality_count
          FROM (
            SELECT DISTINCT ON (bt.user_id) bt.quality
              FROM boardsesh_ticks bt
             WHERE bt.board_type = ${boardType}
               AND bt.climb_uuid = ${climbUuid}
               AND bt.angle      = ${angle}
               AND bt.origin     = 'native'
               AND bt.status IN ('flash','send')
               AND bt.quality IS NOT NULL
               AND bt.quality >= 1
               AND bt.quality <= 5
               AND bt.kilter_detached_at IS NULL
             ORDER BY bt.user_id, bt.climbed_at DESC, bt.id DESC
          ) latest
      ),
      owner AS (
        SELECT bc.user_id IS NOT NULL AS boardsesh_owned
          FROM board_climbs bc
         WHERE bc.board_type = ${boardType}
           AND bc.uuid       = ${climbUuid}
      ),
      -- Is this row's grade ours to write? (#4798) Read from the CURRENT row —
      -- the UPDATE below overwrites tick_graded_at, so the test has to happen
      -- before it, not inside its SET list. Empty when no row exists yet, which
      -- the COALESCE below reads as FALSE (and the UPDATE then matches nothing).
      --
      -- Under READ COMMITTED this CTE reads the statement snapshot, so an
      -- upstream sync that commits between the snapshot and the UPDATE's
      -- EvalPlanQual re-check leaves the flag stale for one pass: we can
      -- overwrite a grade upstream had just written. Bounded and self-healing —
      -- the next catalog pass re-stamps upstream_synced_at over our
      -- tick_graded_at and every later recompute declines. The bulk path has no
      -- such window: it evaluates the predicate inline against the row version
      -- the UPDATE actually locks.
      grade_source AS (
        SELECT ${deriveGradeFromTicksSql('s')} AS derive_from_ticks
          FROM board_climb_stats s
         WHERE s.board_type = ${boardType}
           AND s.climb_uuid = ${climbUuid}
           AND s.angle      = ${angle}
      ),
      updated AS (
        UPDATE board_climb_stats s
           SET boardsesh_ascensionist_count = COALESCE(agg.distinct_senders, 0),
               ascensionist_count           = COALESCE(s.upstream_ascensionist_count, 0)
                                            + COALESCE(agg.distinct_senders, 0),
               -- Boardsesh side of the quality blend (both NULL when no votes).
               -- Owned climbs are never blended (quality_average is a plain AVG),
               -- so these blend-input columns are meaningless there — keep them
               -- NULL so they carry a single consistent meaning (non-owned only).
               boardsesh_quality_sum        = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE) THEN NULL
                 ELSE bq.bs_quality_sum END,
               boardsesh_quality_count      = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE) THEN NULL
                 ELSE NULLIF(bq.bs_quality_count, 0) END,
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
               -- Owned climbs: plain AVG over all ticks. Non-owned: the blend of
               -- upstream_quality_average and the Boardsesh vote just computed.
               quality_average = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN agg.avg_quality
                 ELSE ${singleKeyBlend}
               END,
               quality_normalized = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   THEN TRUE
                 ELSE s.quality_normalized
               END,
               -- Grade columns (#4798): derive when the climb is ours OR the
               -- row's grade is (no grade yet, or one we wrote and upstream has
               -- not stamped since). Otherwise upstream's grade stands.
               difficulty_average = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   OR COALESCE((SELECT derive_from_ticks FROM grade_source), FALSE)
                   THEN agg.avg_difficulty
                 ELSE s.difficulty_average
               END,
               display_difficulty = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   OR COALESCE((SELECT derive_from_ticks FROM grade_source), FALSE)
                   THEN agg.avg_difficulty
                 ELSE s.display_difficulty
               END,
               -- Marks the grade above as tick-derived. Cleared when the derive
               -- produced nothing (last graded tick deleted/detached) so the row
               -- goes back to "ungraded", not "ours but blank". UTC wall time,
               -- not bare now(): this column is compared against
               -- upstream_synced_at, which every upstream writer stores as a JS
               -- ISO string, and both live in zoneless timestamp columns.
               tick_graded_at = CASE
                 WHEN COALESCE((SELECT boardsesh_owned FROM owner), FALSE)
                   OR COALESCE((SELECT derive_from_ticks FROM grade_source), FALSE)
                   THEN (CASE WHEN agg.avg_difficulty IS NULL THEN NULL ELSE (now() AT TIME ZONE 'UTC') END)
                 ELSE s.tick_graded_at
               END
          FROM agg, bs_quality bq
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
 * top-level db. Does not open its own transaction. With a top-level db the seed
 * and update are not atomic; an interruption can leave an empty seed until the
 * next call, whose individually idempotent statements repair that partial state.
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

  // Same non-owned quality blend as the single-key path; s.upstream_* are the
  // current stored values (this UPDATE never changes them).
  const bulkBlend = blendedQualityAverageSql({
    upstreamQualityAverage: sql`s.upstream_quality_average`,
    upstreamAscensionistCount: sql`s.upstream_ascensionist_count`,
    boardseshQualitySum: sql`bq.bs_quality_sum`,
    boardseshQualityCount: sql`bq.bs_quality_count`,
  });

  for (let i = 0; i < distinct.length; i += BULK_CHUNK_SIZE) {
    const chunk = distinct.slice(i, i + BULK_CHUNK_SIZE);
    const payload = JSON.stringify(
      chunk.map((key) => ({ board_type: key.boardType, climb_uuid: key.climbUuid, angle: key.angle })),
    );

    // Defensive seed for keys whose stats row doesn't exist yet (ticks can
    // arrive at angles the saveClimb seed didn't cover). Guarded on both the
    // climb existing in board_climbs (#3528) and a matching attached flash/send
    // tick — see the module doc. The board_climbs EXISTS rides board_climbs_pkey,
    // one probe per key. Existing keys still reach the UPDATE below even when
    // that tick guard is now false.
    //
    // The MoonBoard wrong-angle legs (#3529) live INSIDE the board_climbs EXISTS
    // because that is the only place bc.angle is in scope here — the single-key
    // seed above carries the identical predicate with board_climbs in its outer
    // FROM. Leg for leg, including `bc.user_id IS NOT NULL`: a USER-CREATED climb
    // is outside the guard entirely, matching resolveMoonBoardTickAngle and
    // the moonboard_wrong_angle_stats_cleanup migration's `bc.user_id IS NULL` fence. editClimb leaves a stats row
    // behind at the old angle by design, so a tick at that angle is legitimate
    // and must still seed. The bulk path reaches the same ticks the single-key
    // one does (self-heal, backfills), so a leg missing here would re-open the
    // hole for every writer that batches.
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle,
                                     ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count,
                                     quality_normalized)
      SELECT k.board_type, k.climb_uuid, k.angle, 0, 0, 0, TRUE
        FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
       WHERE EXISTS (
         SELECT 1
           FROM board_climbs bc
          WHERE bc.uuid = k.climb_uuid
            AND bc.board_type = k.board_type
            AND (
              k.board_type <> 'moonboard'
              OR bc.user_id IS NOT NULL
              OR bc.angle IS NULL
              OR bc.angle = k.angle
              OR EXISTS (
                SELECT 1
                  FROM board_climb_stats s
                 WHERE s.board_type = k.board_type
                   AND s.climb_uuid = k.climb_uuid
                   AND s.angle      = k.angle
                   AND ${statsRowCarriesRealCatalogDataSql('s')}
              )
            )
       )
         AND EXISTS (
           SELECT 1
             FROM boardsesh_ticks seed_tick
            WHERE seed_tick.board_type = k.board_type
              AND seed_tick.climb_uuid = k.climb_uuid
              AND seed_tick.angle = k.angle
              AND seed_tick.status IN ('flash','send')
              AND seed_tick.kilter_detached_at IS NULL
         )
      ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING;
    `);

    await db.execute(sql`
      WITH keys AS (
        SELECT board_type, climb_uuid, angle
          FROM jsonb_to_recordset(${payload}::jsonb) AS k(board_type text, climb_uuid text, angle integer)
      ),
      per_user AS (
        SELECT bt.board_type, bt.climb_uuid, bt.angle, bt.user_id,
               -- A user counts when they have an UNABSORBED native flash/send
               -- tick. Absorbed = pushed to Kilter (kilter_id set) long enough
               -- ago that the upstream snapshot has plausibly re-counted it
               -- (kilter_synced_at < upstream_synced_at - 48h); such a tick's
               -- user is already inside upstream_ascensionist_count via the
               -- push, so counting the native tick too would double-count. A
               -- fresh push (within 48h, or synced after upstream) still counts
               -- immediately; upstream_synced_at NULL (MoonBoard / owned) is
               -- never absorbed. s.upstream_synced_at is constant per key.
               bool_or(
                 bt.origin = 'native' AND bt.status IN ('flash','send')
                 AND NOT (
                   bt.kilter_id IS NOT NULL
                   AND bt.kilter_synced_at IS NOT NULL
                   AND s.upstream_synced_at IS NOT NULL
                   AND bt.kilter_synced_at < s.upstream_synced_at - interval '48 hours'
                 )
               ) AS has_unabsorbed_native_send,
               -- Only imported FLASH/SEND ticks mark a user as upstream-
               -- represented: upstream ascent counts don't include bids, so an
               -- imported attempt must not disqualify a native send.
               bool_or(bt.origin <> 'native' AND bt.status IN ('flash','send')) AS has_upstream
          FROM boardsesh_ticks bt
          JOIN keys k
            ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
          -- Inner join, and since #3528 it is also load-bearing: the seed above
          -- only creates rows for keys whose climb exists in board_climbs, so a
          -- phantom key has no stats row and drops out here. That is the
          -- intended outcome — the UPDATE at the bottom would match nothing for
          -- it anyway. For every surviving key the seed guarantees a row, so
          -- upstream_synced_at is always available.
          JOIN board_climb_stats s
            ON s.board_type = bt.board_type AND s.climb_uuid = bt.climb_uuid AND s.angle = bt.angle
         -- Kilter-detached rows are upstream-deleted; they must not count nor
         -- keep a user "upstream-represented" (see kilter_detached_at docs).
         WHERE bt.kilter_detached_at IS NULL
         GROUP BY bt.board_type, bt.climb_uuid, bt.angle, bt.user_id
      ),
      counts AS (
        SELECT board_type, climb_uuid, angle,
               COUNT(*) FILTER (WHERE has_unabsorbed_native_send AND NOT has_upstream) AS distinct_senders
          FROM per_user
         GROUP BY board_type, climb_uuid, angle
      ),
      sends AS (
        SELECT bt.board_type, bt.climb_uuid, bt.angle,
               MIN(bt.climbed_at)                                     AS first_at,
               AVG(bt.quality) FILTER (WHERE bt.quality BETWEEN 1 AND 5) AS avg_quality,
               AVG(bt.difficulty) FILTER (WHERE bt.difficulty > 1)       AS avg_difficulty
          FROM boardsesh_ticks bt
          JOIN keys k
            ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
         WHERE bt.status IN ('flash','send')
           AND bt.kilter_detached_at IS NULL
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
           AND bt.kilter_detached_at IS NULL
         ORDER BY bt.board_type, bt.climb_uuid, bt.angle, bt.climbed_at ASC
      ),
      -- The blend's Boardsesh side, per key: one vote per climber = their LATEST
      -- rated native flash/send tick (max climbed_at, tie-break max id). origin
      -- filter keeps imported ratings out (already in upstream_quality_average).
      bs_quality AS (
        SELECT latest.board_type, latest.climb_uuid, latest.angle,
               SUM(latest.quality)::double precision AS bs_quality_sum,
               COUNT(*)::bigint                      AS bs_quality_count
          FROM (
            SELECT DISTINCT ON (bt.board_type, bt.climb_uuid, bt.angle, bt.user_id)
                   bt.board_type, bt.climb_uuid, bt.angle, bt.quality
              FROM boardsesh_ticks bt
              JOIN keys k
                ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
             WHERE bt.origin = 'native'
               AND bt.status IN ('flash','send')
               AND bt.quality IS NOT NULL
               AND bt.quality >= 1
               AND bt.quality <= 5
               AND bt.kilter_detached_at IS NULL
             ORDER BY bt.board_type, bt.climb_uuid, bt.angle, bt.user_id, bt.climbed_at DESC, bt.id DESC
          ) latest
         GROUP BY latest.board_type, latest.climb_uuid, latest.angle
      )
      UPDATE board_climb_stats s
         SET boardsesh_ascensionist_count = COALESCE(c.distinct_senders, 0),
             ascensionist_count           = COALESCE(s.upstream_ascensionist_count, 0)
                                          + COALESCE(c.distinct_senders, 0),
             -- Boardsesh side of the quality blend (both NULL when no votes).
             -- NULL for owned climbs — they're never blended, so these
             -- blend-input columns carry a single consistent meaning (non-owned).
             boardsesh_quality_sum        = CASE WHEN owned.boardsesh_owned THEN NULL ELSE bq.bs_quality_sum END,
             boardsesh_quality_count      = CASE WHEN owned.boardsesh_owned THEN NULL ELSE NULLIF(bq.bs_quality_count, 0) END,
             -- Owned climbs re-derive FA from the earliest tick; non-owned
             -- climbs preserve the manufacturer's stored FA verbatim (never
             -- derived or filled from ticks — see the module doc).
             fa_username = CASE WHEN owned.boardsesh_owned
                                  THEN fu.crown
                                  ELSE s.fa_username END,
             fa_at       = CASE WHEN owned.boardsesh_owned
                                  THEN sd.first_at
                                  ELSE s.fa_at END,
             -- Owned climbs: plain AVG. Non-owned: blend of upstream_quality_average
             -- and the Boardsesh vote (bq), rewritten in this same statement.
             quality_average    = CASE WHEN owned.boardsesh_owned THEN sd.avg_quality    ELSE ${bulkBlend} END,
             quality_normalized = CASE WHEN owned.boardsesh_owned THEN TRUE              ELSE s.quality_normalized END,
             -- Grade columns (#4798): derive when the climb is ours OR the row's
             -- grade is (no grade yet, or one we wrote and upstream has not
             -- stamped since — deriveGradeFromTicksSql). s is the pre-UPDATE
             -- row here, so tick_graded_at in the predicate is the stored value,
             -- not the one being written on the line below.
             difficulty_average = CASE WHEN owned.boardsesh_owned OR ${deriveGradeFromTicksSql('s')}
                                         THEN sd.avg_difficulty ELSE s.difficulty_average END,
             display_difficulty = CASE WHEN owned.boardsesh_owned OR ${deriveGradeFromTicksSql('s')}
                                         THEN sd.avg_difficulty ELSE s.display_difficulty END,
             -- Marks the grade above as tick-derived; cleared when the derive
             -- produced nothing (last graded tick gone), so the row reads
             -- "ungraded" rather than "ours but blank". UTC wall time, not bare
             -- now() — it is compared against upstream_synced_at, which upstream
             -- writers store as a JS ISO string in a zoneless column.
             tick_graded_at     = CASE WHEN owned.boardsesh_owned OR ${deriveGradeFromTicksSql('s')}
                                         THEN (CASE WHEN sd.avg_difficulty IS NULL THEN NULL ELSE (now() AT TIME ZONE 'UTC') END)
                                         ELSE s.tick_graded_at END
        FROM keys k
        LEFT JOIN counts c
          ON c.board_type = k.board_type AND c.climb_uuid = k.climb_uuid AND c.angle = k.angle
        LEFT JOIN sends sd
          ON sd.board_type = k.board_type AND sd.climb_uuid = k.climb_uuid AND sd.angle = k.angle
        LEFT JOIN first_user fu
          ON fu.board_type = k.board_type AND fu.climb_uuid = k.climb_uuid AND fu.angle = k.angle
        LEFT JOIN bs_quality bq
          ON bq.board_type = k.board_type AND bq.climb_uuid = k.climb_uuid AND bq.angle = k.angle
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
