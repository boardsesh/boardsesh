import { and, asc, eq, getTableName, gt, gte, inArray, isNotNull, lte, max, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { boardClimbPopularity, boardClimbPopularityRuns, boardClimbStats } from '../../schema/index';

/**
 * Keeps `board_climb_popularity` in step with `board_climb_stats`. The body of
 * the backend's `climb-popularity-refresh` job.
 *
 * Per board:
 *  - **Full** (the board's first run, and weekly after that): every climb, in
 *    chunks of about `FULL_CHUNK_STATS_ROWS` stats rows cut on climb_uuid, so a
 *    climb's rows always land in one statement. `full_built_at` is stamped only
 *    when the last chunk is done; until then the search keeps the old
 *    aggregation for the board.
 *  - **Incremental** (every other run): only the climbs with a stats row whose
 *    `updated_at` is at or after the last run's high-water mark minus
 *    `WATERMARK_SLACK`, read through `board_climb_stats_sync_cursor_idx`. The
 *    stats trigger bumps `updated_at` whenever `ascensionist_count` or
 *    `display_difficulty` changes, and a new stats row starts at now(), so this
 *    sees every change the table carries.
 *
 * Every write is an upsert that skips unchanged rows, plus a delete of rows
 * whose stats row is gone, so a rerun costs reads, not writes. A stats row
 * deleted from a climb nobody touched since is only noticed by the weekly
 * full pass; the search re-checks the live stats row, so until then it only
 * affects that climb's rank, never whether it shows.
 */

export type ClimbPopularityDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Stats rows per full-build statement. Kilter (420k rows) is about 21 statements. */
export const FULL_CHUNK_STATS_ROWS = 20_000;
/** Climbs per incremental statement, bound as one array. */
export const INCREMENTAL_CHUNK_CLIMBS = 5_000;
/**
 * `updated_at` is stamped when a stats row is written, not when its transaction
 * commits, so a sync transaction still open when a run reads the high-water
 * mark commits rows stamped below it. An hour covers the longest writer on
 * record (Kilter catalog upserts of 80-135 s) many times over.
 */
export const WATERMARK_SLACK = '1 hour';
/** A full pass this often catches stats rows deleted outright. */
export const FULL_REBUILD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An incremental run that would touch more climbs than this does a full pass
 * instead: the chunked range scans read less than that many array-bound
 * lookups. About a fifth of Kilter's 255k climbs with stats.
 */
export const INCREMENTAL_MAX_CLIMBS = 50_000;

export type ClimbPopularityBoardResult = {
  boardType: BoardName;
  mode: 'full' | 'incremental' | 'empty';
  climbsConsidered: number;
  statements: number;
  milliseconds: number;
};

export type ClimbPopularityRefreshOptions = {
  boardTypes?: readonly BoardName[];
  /** Force a full pass on every board. */
  full?: boolean;
  /** Checked between statements; returning false stops the run where it is. */
  shouldContinue?: () => boolean;
};

/**
 * The upsert both passes share: recompute every stats row of the climbs
 * `statsScope` selects, with the climb's total over every angle, and write the
 * rows whose values moved. `statsScope` must select whole climbs (every angle
 * of each climb it names), or a partial window would write a partial total.
 */
async function upsertClimbs(db: ClimbPopularityDb, boardType: BoardName, statsScope: SQL | undefined): Promise<void> {
  const computed = db
    .select({
      boardType: boardClimbStats.boardType,
      climbUuid: boardClimbStats.climbUuid,
      angle: boardClimbStats.angle,
      // The old popular_counts subquery's exact expression, per climb.
      totalAscensionistCount:
        sql<number>`COALESCE(SUM(${boardClimbStats.ascensionistCount}) OVER (PARTITION BY ${boardClimbStats.climbUuid}), 0)`.as(
          'total_ascensionist_count',
        ),
      displayDifficulty: boardClimbStats.displayDifficulty,
      ascensionistCount: boardClimbStats.ascensionistCount,
    })
    .from(boardClimbStats)
    .where(and(eq(boardClimbStats.boardType, boardType), statsScope));

  await db
    .insert(boardClimbPopularity)
    .select(computed)
    .onConflictDoUpdate({
      target: [boardClimbPopularity.boardType, boardClimbPopularity.climbUuid, boardClimbPopularity.angle],
      set: {
        totalAscensionistCount: sql`excluded.total_ascensionist_count`,
        displayDifficulty: sql`excluded.display_difficulty`,
        ascensionistCount: sql`excluded.ascensionist_count`,
      },
      // No dead tuple for a row that did not change: a rerun is reads only.
      setWhere: sql`(${boardClimbPopularity.totalAscensionistCount}, ${boardClimbPopularity.displayDifficulty}, ${boardClimbPopularity.ascensionistCount})
        IS DISTINCT FROM (excluded.total_ascensionist_count, excluded.display_difficulty, excluded.ascensionist_count)`,
    });
}

/** Drop rows of the climbs `popularityScope` selects whose stats row no longer exists. */
async function deleteOrphans(
  db: ClimbPopularityDb,
  boardType: BoardName,
  popularityScope: SQL | undefined,
): Promise<void> {
  await db.delete(boardClimbPopularity).where(
    and(
      eq(boardClimbPopularity.boardType, boardType),
      popularityScope,
      sql`NOT EXISTS (
        SELECT 1 FROM ${boardClimbStats}
        WHERE ${boardClimbStats.boardType} = ${boardClimbPopularity.boardType}
          AND ${boardClimbStats.climbUuid} = ${boardClimbPopularity.climbUuid}
          AND ${boardClimbStats.angle} = ${boardClimbPopularity.angle}
      )`,
    ),
  );
}

async function statsHighWaterMark(db: ClimbPopularityDb, boardType: BoardName): Promise<string | null> {
  // Backward walk of board_climb_stats_sync_cursor_idx: one index entry.
  const [row] = await db
    .select({ through: sql<string | null>`${max(boardClimbStats.updatedAt)}::text` })
    .from(boardClimbStats)
    .where(eq(boardClimbStats.boardType, boardType));
  return row?.through ?? null;
}

/** The climb_uuid that closes the chunk starting after `after`, or null when the rest fits in one. */
async function nextChunkEnd(db: ClimbPopularityDb, boardType: BoardName, after: string | null): Promise<string | null> {
  const [row] = await db
    .select({ climbUuid: boardClimbStats.climbUuid })
    .from(boardClimbStats)
    .where(
      and(eq(boardClimbStats.boardType, boardType), after === null ? undefined : gt(boardClimbStats.climbUuid, after)),
    )
    .orderBy(asc(boardClimbStats.climbUuid))
    .offset(FULL_CHUNK_STATS_ROWS - 1)
    .limit(1);
  return row?.climbUuid ?? null;
}

async function runFullPass(
  db: ClimbPopularityDb,
  boardType: BoardName,
  shouldContinue: () => boolean,
): Promise<{ statements: number; completed: boolean }> {
  let statements = 0;
  let after: string | null = null;
  for (;;) {
    if (!shouldContinue()) return { statements, completed: false };
    const end = await nextChunkEnd(db, boardType, after);
    // (after, end]: whole climbs, because the chunk is cut on climb_uuid.
    await upsertClimbs(
      db,
      boardType,
      and(
        after === null ? undefined : gt(boardClimbStats.climbUuid, after),
        end === null ? undefined : lte(boardClimbStats.climbUuid, end),
      ),
    );
    await deleteOrphans(
      db,
      boardType,
      and(
        after === null ? undefined : gt(boardClimbPopularity.climbUuid, after),
        end === null ? undefined : lte(boardClimbPopularity.climbUuid, end),
      ),
    );
    statements += 2;
    if (end === null) return { statements, completed: true };
    after = end;
  }
}

async function touchedClimbs(db: ClimbPopularityDb, boardType: BoardName, since: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ climbUuid: boardClimbStats.climbUuid })
    .from(boardClimbStats)
    .where(
      and(
        eq(boardClimbStats.boardType, boardType),
        gte(boardClimbStats.updatedAt, sql`${since}::timestamp - ${WATERMARK_SLACK}::interval`),
      ),
    );
  return rows.map((row) => row.climbUuid);
}

export async function refreshClimbPopularityForBoard(
  db: ClimbPopularityDb,
  boardType: BoardName,
  options: Pick<ClimbPopularityRefreshOptions, 'full' | 'shouldContinue'> = {},
): Promise<ClimbPopularityBoardResult> {
  const startedAt = Date.now();
  const shouldContinue = options.shouldContinue ?? (() => true);

  // Read the high-water mark BEFORE any stats row, so a row written during the
  // run is either read now or re-read by the next run.
  const through = await statsHighWaterMark(db, boardType);
  if (through === null) {
    return { boardType, mode: 'empty', climbsConsidered: 0, statements: 0, milliseconds: Date.now() - startedAt };
  }

  const [run] = await db
    .select({
      statsUpdatedThrough: boardClimbPopularityRuns.statsUpdatedThrough,
      // Compared in SQL against the same clock that stamped it.
      fullPassDue: sql<boolean>`${boardClimbPopularityRuns.fullBuiltAt} IS NULL
        OR ${boardClimbPopularityRuns.fullBuiltAt} <= now() - make_interval(secs => ${FULL_REBUILD_INTERVAL_MS / 1000})`,
    })
    .from(boardClimbPopularityRuns)
    .where(eq(boardClimbPopularityRuns.boardType, boardType));

  const fullDue = options.full === true || !run || run.fullPassDue || !run.statsUpdatedThrough;

  let mode: 'full' | 'incremental' = fullDue ? 'full' : 'incremental';
  let climbsConsidered = 0;
  let statements = 0;

  if (mode === 'incremental' && run?.statsUpdatedThrough) {
    const climbs = await touchedClimbs(db, boardType, run.statsUpdatedThrough);
    climbsConsidered = climbs.length;
    if (climbs.length > INCREMENTAL_MAX_CLIMBS) {
      mode = 'full';
    } else {
      for (let offset = 0; offset < climbs.length; offset += INCREMENTAL_CHUNK_CLIMBS) {
        if (!shouldContinue()) {
          return { boardType, mode, climbsConsidered, statements, milliseconds: Date.now() - startedAt };
        }
        const chunk = climbs.slice(offset, offset + INCREMENTAL_CHUNK_CLIMBS);
        await upsertClimbs(db, boardType, inArray(boardClimbStats.climbUuid, chunk));
        await deleteOrphans(db, boardType, inArray(boardClimbPopularity.climbUuid, chunk));
        statements += 2;
      }
    }
  }

  if (mode === 'full') {
    const full = await runFullPass(db, boardType, shouldContinue);
    statements += full.statements;
    if (!full.completed) {
      return { boardType, mode, climbsConsidered, statements, milliseconds: Date.now() - startedAt };
    }
  }

  const stamp = {
    statsUpdatedThrough: through,
    refreshedAt: sql`now()`,
    ...(mode === 'full' ? { fullBuiltAt: sql`now()` } : {}),
  };
  await db
    .insert(boardClimbPopularityRuns)
    .values({ boardType, ...stamp })
    .onConflictDoUpdate({ target: boardClimbPopularityRuns.boardType, set: stamp });

  return { boardType, mode, climbsConsidered, statements, milliseconds: Date.now() - startedAt };
}

/** Refresh every board, or `options.boardTypes`. Boards are independent; one failing stops the rest. */
export async function refreshClimbPopularity(
  db: ClimbPopularityDb,
  options: ClimbPopularityRefreshOptions = {},
): Promise<ClimbPopularityBoardResult[]> {
  const results: ClimbPopularityBoardResult[] = [];
  for (const boardType of options.boardTypes ?? SUPPORTED_BOARDS) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    results.push(await refreshClimbPopularityForBoard(db, boardType, options));
  }
  return results;
}

/**
 * How long a process trusts one answer to "is the table built for this board?".
 * The answer only ever flips from no to yes (once per board, at the end of its
 * first build), so a stale "no" costs a minute of the old aggregation, never a
 * wrong row.
 */
const READINESS_TTL_MS = 60_000;
const readinessCache = new Map<string, { ready: boolean; checkedAt: number }>();

/** Test-only: forget cached readiness answers. */
export function resetClimbPopularityReadinessForTests(): void {
  readinessCache.clear();
}

/**
 * False while autovacuum still owes `board_climb_popularity` an ANALYZE: more
 * rows changed since the last one than its own trigger (threshold + scale
 * factor x rows). Right after the first build the table has no statistics, the
 * planner guesses about 9 rows per (board, angle) instead of about 200k, and
 * the fallback's LEFT JOIN on the table becomes a nested loop over a
 * materialised scan: a Kilter Boardsesh-grade band took 117 s instead of 0.9 s
 * on the dev DB. The runtime role cannot ANALYZE (it holds no MAINTAIN), so the
 * search waits for autovacuum, about a minute. The hourly incremental writes
 * stay far under the trigger. The counters are per server and reset after a
 * crash; a reset reads as zero changes, and the statistics themselves survive.
 */
function analyzedSinceBulkWrite(): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_stat_user_tables AS popularity_stats
    JOIN pg_catalog.pg_class AS popularity_class ON popularity_class.oid = popularity_stats.relid
    WHERE popularity_stats.relid = to_regclass(${getTableName(boardClimbPopularity)})
      AND popularity_stats.n_mod_since_analyze >
        current_setting('autovacuum_analyze_threshold')::float8
        + current_setting('autovacuum_analyze_scale_factor')::float8 * GREATEST(popularity_class.reltuples, 0)
  )`;
}

/**
 * Whether the popular sort may read `board_climb_popularity` for this board:
 * true once a full build has finished and the table has been analyzed since
 * (see analyzedSinceBulkWrite). Any failure (the table not migrated
 * yet, a test double without a query builder) answers false, which keeps the
 * old aggregation — slower, never wrong.
 */
export async function isClimbPopularityReady(
  db: Pick<ClimbPopularityDb, 'select'>,
  boardType: string,
): Promise<boolean> {
  const cached = readinessCache.get(boardType);
  if (cached && Date.now() - cached.checkedAt < READINESS_TTL_MS) return cached.ready;
  let ready = false;
  try {
    const rows = await db
      .select({ boardType: boardClimbPopularityRuns.boardType })
      .from(boardClimbPopularityRuns)
      .where(
        and(
          eq(boardClimbPopularityRuns.boardType, boardType),
          isNotNull(boardClimbPopularityRuns.fullBuiltAt),
          analyzedSinceBulkWrite(),
        ),
      )
      .limit(1);
    ready = rows.length > 0;
  } catch {
    ready = false;
  }
  readinessCache.set(boardType, { ready, checkedAt: Date.now() });
  return ready;
}
