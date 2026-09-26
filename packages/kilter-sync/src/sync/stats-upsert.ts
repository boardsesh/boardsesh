import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbStats } from '@boardsesh/db/schema';
import { blendedQualityAverageSql, conflictSetChangesRowSql, type ConflictSetEntry } from '@boardsesh/db/queries';
import { commandCountFromResult } from '@boardsesh/db/client';

import { kilterStatsGradeConflictSet } from './stats-grade-conflict';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';
const BATCH = 1000;

/**
 * How long an unchanged row that Boardsesh ticks count on may keep its
 * upstream_synced_at before a pass restamps it anyway. The tick recompute reads
 * that stamp for push-back absorption
 * (`kilter_synced_at < upstream_synced_at - 48h`, recompute.ts), so it has to
 * keep moving while Grips keeps confirming the row. 24 h delays a pushed tick's
 * absorption by at most a day past the 48 h horizon.
 */
export const KILTER_STATS_RESTAMP_INTERVAL = '24 hours';

/** One (canonical, angle) stat row a Kilter Grips writer sends to board_climb_stats. */
export type KilterStatsUpsertRow = {
  climbUuid: string;
  angle: number;
  displayDifficulty: number | null;
  difficultyAverage: number | null;
  /** Grips' own 1-5 quality. Seeds both quality_average and upstream_quality_average. */
  qualityAverage: number | null;
  faUsername: string | null;
  faAt: string | null;
  upstreamAscensionistCount: number;
};

/**
 * - `raise-only`: the routine catalog sync. GREATEST of stored and incoming, so a
 *   partial fetch can never lower a climb.
 * - `authoritative`: stats-repair, which reconciles to the live Grips catalog and
 *   may correct a count downward.
 */
export type KilterUpstreamCountPolicy = 'raise-only' | 'authoritative';

type SetEntry = ConflictSetEntry;

/**
 * The ON CONFLICT SET both Kilter Grips writers ship, as (column, new value)
 * pairs. Every pair feeds both the SET and the no-op guard, so the guard can
 * never miss a column the SET writes. upstream_synced_at is deliberately not in
 * the list: it moves only when something else does, or when it is stale.
 */
export function kilterStatsConflictSet(policy: KilterUpstreamCountPolicy): SetEntry[] {
  // The NEW upstream count, reused for the count, the total AND the blend weight:
  // a Postgres SET reads the OLD value of a bare column, so the blend must weight
  // by this expression, not the column.
  const resolvedUpstreamCount =
    policy === 'raise-only'
      ? sql`GREATEST(COALESCE(${boardClimbStats.upstreamAscensionistCount}, 0), COALESCE(excluded.upstream_ascensionist_count, 0))`
      : sql`excluded.upstream_ascensionist_count`;
  // Aurora-origin canonicals have no Grips quality (excluded is NULL): keep the
  // stored upstream quality. Kilter-origin canonicals clobber with the Grips value.
  const upstreamQualityAverage = sql`COALESCE(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`;
  const grade = kilterStatsGradeConflictSet();
  return [
    { column: boardClimbStats.upstreamAscensionistCount, value: resolvedUpstreamCount },
    {
      column: boardClimbStats.ascensionistCount,
      value: sql`COALESCE(${resolvedUpstreamCount}, 0) + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
    },
    // Grips is authoritative when it supplies a grade, silent when it does not;
    // tick_graded_at rides along with it (#4798). See kilterStatsGradeConflictSet.
    { column: boardClimbStats.displayDifficulty, value: grade.displayDifficulty },
    { column: boardClimbStats.difficultyAverage, value: grade.difficultyAverage },
    { column: boardClimbStats.tickGradedAt, value: grade.tickGradedAt },
    { column: boardClimbStats.upstreamQualityAverage, value: upstreamQualityAverage },
    {
      column: boardClimbStats.qualityAverage,
      value: blendedQualityAverageSql({
        upstreamQualityAverage,
        upstreamAscensionistCount: resolvedUpstreamCount,
        boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
        boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
      }),
    },
    // Grips quality is natively 1-5, so a written row is always normalized.
    { column: boardClimbStats.qualityNormalized, value: sql`true` },
    // fa_* COALESCE deliberately kept as-is (#3536): the sanitizeFirstAscent guard
    // in foldCatalogStat only stops NEW garbage from landing, so an
    // already-poisoned stored fa_at survives until the deferred prod cleanup.
    { column: boardClimbStats.faUsername, value: sql`COALESCE(excluded.fa_username, ${boardClimbStats.faUsername})` },
    { column: boardClimbStats.faAt, value: sql`COALESCE(excluded.fa_at, ${boardClimbStats.faAt})` },
  ];
}

/**
 * The ON CONFLICT … WHERE guard. It runs on the locked, current row, so a
 * concurrent tick recompute can never make it skip a needed write. A row is
 * written when:
 *
 * 1. some SET column would change (every one of them, including those the
 *    sync_seq trigger does not watch: upstream_*, tick_graded_at,
 *    quality_normalized); or
 * 2. it has never been upstream-stamped, which is a one-off per row; or
 * 3. its stamp is older than KILTER_STATS_RESTAMP_INTERVAL AND Boardsesh ticks
 *    count on it (boardsesh_ascensionist_count > 0).
 *
 * Why 3 is narrowed: the stamp's only runtime reader is the recompute's
 * absorption rule, and absorption can only lower boardsesh_ascensionist_count.
 * With that count at 0 nobody is counted, a frozen stamp never moves backward
 * (already-absorbed ticks stay absorbed), and a new push that makes the count
 * positive puts the row back under the daily restamp. Restamping all ~420k
 * rows daily would instead write every row once a day; 12.7k Kilter rows
 * (3%) carry Boardsesh ascents on the replica.
 *
 * Why it matters: a pass used to rewrite every Kilter row (~420k, about 3
 * passes a day) although ≤0.2% changed. Each rewrite left a dead tuple, index
 * entries when the page was full, and WAL. The sync_seq trigger already ignored
 * those rewrites, so offline clients see no difference.
 */
export function kilterStatsConflictWhere(set: SetEntry[]): SQL {
  return sql`${conflictSetChangesRowSql(set)}
    OR ${boardClimbStats.upstreamSyncedAt} IS NULL
    OR (
      ${boardClimbStats.upstreamSyncedAt} < excluded.upstream_synced_at - interval '${sql.raw(KILTER_STATS_RESTAMP_INTERVAL)}'
      AND COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0) > 0
    )`;
}

/**
 * One chunk as a single statement: every column travels as one typed array
 * through unnest(), so the statement text (and its pg_stat_statements queryid)
 * is the same for any chunk size. The multi-row VALUES form it replaces minted
 * one queryid per distinct remainder, 852 of them for this one writer.
 *
 * Raw SQL because Drizzle's insert().select() must name every table column in
 * table order, and board_climb_stats has defaulted columns (sync_seq,
 * updated_at, the Boardsesh aggregates) this writer must leave to their
 * defaults.
 */
export function buildKilterStatsUpsert(
  rows: KilterStatsUpsertRow[],
  options: { policy: KilterUpstreamCountPolicy; syncedAt: string },
): SQL {
  const set = kilterStatsConflictSet(options.policy);
  const assignments = sql.join(
    [
      ...set.map((entry) => sql`${sql.identifier(entry.column.name)} = ${entry.value}`),
      sql`${sql.identifier(boardClimbStats.upstreamSyncedAt.name)} = excluded.upstream_synced_at`,
    ],
    sql`, `,
  );
  return sql`
    INSERT INTO ${boardClimbStats} (
      board_type, climb_uuid, angle, display_difficulty, difficulty_average,
      quality_average, upstream_quality_average, quality_normalized,
      fa_username, fa_at, upstream_ascensionist_count, ascensionist_count, upstream_synced_at
    )
    SELECT ${KILTER}, incoming.climb_uuid, incoming.angle, incoming.display_difficulty, incoming.difficulty_average,
           incoming.quality_average, incoming.quality_average, true,
           incoming.fa_username, incoming.fa_at::timestamp, incoming.upstream_count::bigint,
           incoming.upstream_count::bigint, ${options.syncedAt}::timestamp
      FROM unnest(
        ${sql.param(rows.map((row) => row.climbUuid))}::text[],
        ${sql.param(rows.map((row) => row.angle))}::integer[],
        ${sql.param(rows.map((row) => row.displayDifficulty))}::double precision[],
        ${sql.param(rows.map((row) => row.difficultyAverage))}::double precision[],
        ${sql.param(rows.map((row) => row.qualityAverage))}::double precision[],
        ${sql.param(rows.map((row) => row.faUsername))}::text[],
        -- postgres-js has no serializer for timestamp[] or bigint[] params, so
        -- these two travel as text[] and are cast per element above.
        ${sql.param(rows.map((row) => row.faAt))}::text[],
        ${sql.param(rows.map((row) => String(row.upstreamAscensionistCount)))}::text[]
      ) AS incoming(climb_uuid, angle, display_difficulty, difficulty_average, quality_average, fa_username, fa_at, upstream_count)
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET ${assignments}
     WHERE ${kilterStatsConflictWhere(set)}
  `;
}

/**
 * Upsert Kilter Grips stats in BATCH-row chunks. Returns how many rows were
 * actually inserted or updated; a row whose values and fresh stamp already
 * match is skipped and not counted.
 */
export async function upsertKilterStats(
  db: DrizzleDb,
  rows: KilterStatsUpsertRow[],
  options: { policy: KilterUpstreamCountPolicy; syncedAt?: string },
): Promise<number> {
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  let written = 0;
  for (let start = 0; start < rows.length; start += BATCH) {
    const chunk = rows.slice(start, start + BATCH);
    const result = await db.execute(buildKilterStatsUpsert(chunk, { policy: options.policy, syncedAt }));
    // INSERT … ON CONFLICT counts inserted + updated rows, never the skipped ones.
    written += commandCountFromResult(result) ?? 0;
  }
  return written;
}
