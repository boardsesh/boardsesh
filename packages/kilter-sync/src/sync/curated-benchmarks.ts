import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbAliases, boardClimbs, boardClimbStats, kilterAuroraBenchmarks } from '@boardsesh/db/schema';
import { realBenchmarkCondition } from '@boardsesh/db/queries';
import { commandCountFromResult } from '@boardsesh/db/client';

import type { KilterCuratedStat } from '../api/kilter-rest';
import { guardDifficulty } from './catalog-parse';
import type { CatalogWriteRunner } from './catalog-sync';

/**
 * Applies Kilter's Verified list to `board_climb_stats.benchmark_difficulty`.
 *
 * Kilter's app has no benchmarks. It marks problems "Verified", and
 * `/api/climbs/curated` lists them per angle. We store that in the benchmark
 * column, so filters, the offline mirror and every row reader work unchanged, and
 * the app labels it Verified on Kilter. Kilter's list is the only source for this
 * column on Kilter: a row it does not list is cleared. The grades Aurora published
 * are frozen in `kilter_aurora_benchmarks` before any of this can run.
 *
 * No other Kilter writer touches the column (`kilterStatsConflictSet` leaves it
 * out, and the Aurora sync refuses Kilter), so this pass owns it.
 */

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';
const BATCH = 1000;

/**
 * The fewest (climb, angle) rows a list must resolve to before this pass writes
 * anything. It resolved to 5,006 rows on 2026-11-09, so this is about half.
 *
 * A floor on the list, rather than a limit on how many rows may change, because a
 * short or truncated list is the failure that would wipe real marks, and a limit
 * on changes would refuse the large first run. If Kilter really does halve its
 * list this refuses and logs, and someone lowers the constant.
 */
export const MIN_CURATED_ANGLE_ROWS = 2500;

export type CuratedBenchmarkReport = {
  /** Distinct (climb, angle) rows on Kilter's list, less any deleted climbs. */
  listed: number;
  /** Of those, the rows on a climb Boardsesh carries. */
  resolved: number;
  /** Climbs on the list Boardsesh does not carry (UP Board, mostly). */
  unresolvedClimbs: number;
  /** Rows whose stored value this pass changed. */
  marked: number;
  /** Rows no longer on the list, set back to NULL. */
  cleared: number;
  /** The list was too short to trust, so nothing was written. */
  refused: boolean;
};

export type CuratedRow = {
  lowerUuid: string;
  sourceUuid: string;
  angle: number;
  officialDifficulty: number | null;
  upstreamDifficulty: number | null;
};

export type CuratedTarget = {
  climbUuid: string;
  angle: number;
  officialDifficulty: number | null;
  upstreamDifficulty: number | null;
};

type MarkedRow = { climbUuid: string; angle: number };

/**
 * One row per (climb, angle). The list repeats rows and mixes uuid casing; a
 * repeat may be the only one carrying the official grade, so the first non-null
 * value wins. A deleted climb is dropped, and a ≤ 1 placeholder grade counts as
 * no grade, as it does for the rest of the catalog.
 */
export function foldCuratedStats(
  stats: readonly KilterCuratedStat[],
  deletedLowerUuids: ReadonlySet<string> | null,
): CuratedRow[] {
  const rowsByKey = new Map<string, CuratedRow>();
  for (const stat of stats) {
    const lowerUuid = stat.climbUuid.toLowerCase();
    if (deletedLowerUuids?.has(lowerUuid)) continue;
    const key = `${lowerUuid}@${stat.angle}`;
    const officialDifficulty = guardDifficulty(stat.officialKilterDifficulty);
    const upstreamDifficulty = guardDifficulty(stat.currentDifficultyId);
    const existing = rowsByKey.get(key);
    if (existing) {
      existing.officialDifficulty ??= officialDifficulty;
      existing.upstreamDifficulty ??= upstreamDifficulty;
    } else {
      rowsByKey.set(key, {
        lowerUuid,
        sourceUuid: stat.climbUuid,
        angle: stat.angle,
        officialDifficulty,
        upstreamDifficulty,
      });
    }
  }
  return [...rowsByKey.values()];
}

/** Every casing an alias might be stored under, so the lookup can use the primary key. */
export function aliasLookupKeys(rows: readonly CuratedRow[]): string[] {
  const keys = new Set<string>();
  for (const { sourceUuid, lowerUuid } of rows) {
    keys.add(sourceUuid);
    keys.add(sourceUuid.toUpperCase());
    keys.add(lowerUuid);
  }
  return [...keys];
}

/** Maps rows onto canonical climbs. Two aliases of one climb merge into a single target. */
export function buildCuratedTargets(
  rows: readonly CuratedRow[],
  canonicalByLowerUuid: ReadonlyMap<string, string>,
): { targets: CuratedTarget[]; unresolvedClimbs: number } {
  const targetsByKey = new Map<string, CuratedTarget>();
  const unresolved = new Set<string>();
  for (const { lowerUuid, angle, officialDifficulty, upstreamDifficulty } of rows) {
    const climbUuid = canonicalByLowerUuid.get(lowerUuid);
    if (!climbUuid) {
      unresolved.add(lowerUuid);
      continue;
    }
    const key = `${climbUuid}@${angle}`;
    const existing = targetsByKey.get(key);
    if (existing) {
      existing.officialDifficulty ??= officialDifficulty;
      existing.upstreamDifficulty ??= upstreamDifficulty;
    } else {
      targetsByKey.set(key, { climbUuid, angle, officialDifficulty, upstreamDifficulty });
    }
  }
  return { targets: [...targetsByKey.values()], unresolvedClimbs: unresolved.size };
}

/** The currently marked rows Kilter no longer lists. */
export function planCuratedClears(markedRows: readonly MarkedRow[], targets: readonly CuratedTarget[]): MarkedRow[] {
  const listed = new Set(targets.map(({ climbUuid, angle }) => `${climbUuid}@${angle}`));
  return markedRows.filter(({ climbUuid, angle }) => !listed.has(`${climbUuid}@${angle}`));
}

async function loadCanonicalByLowerUuid(db: DrizzleDb, rows: readonly CuratedRow[]): Promise<Map<string, string>> {
  const canonicalByLowerUuid = new Map<string, string>();
  const keys = aliasLookupKeys(rows);
  for (let start = 0; start < keys.length; start += BATCH) {
    const aliases = await db
      .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
      .from(boardClimbAliases)
      .where(
        and(
          eq(boardClimbAliases.boardType, KILTER),
          inArray(boardClimbAliases.aliasUuid, keys.slice(start, start + BATCH)),
        ),
      );
    for (const { aliasUuid, canonicalUuid } of aliases)
      canonicalByLowerUuid.set(aliasUuid.toLowerCase(), canonicalUuid);
  }
  return canonicalByLowerUuid;
}

function loadMarkedRows(db: DrizzleDb): Promise<MarkedRow[]> {
  return db
    .select({ climbUuid: boardClimbStats.climbUuid, angle: boardClimbStats.angle })
    .from(boardClimbStats)
    .innerJoin(boardClimbs, eq(boardClimbs.uuid, boardClimbStats.climbUuid))
    .where(
      and(
        eq(boardClimbStats.boardType, KILTER),
        realBenchmarkCondition(boardClimbStats.benchmarkDifficulty),
        isNull(boardClimbs.userId),
      ),
    );
}

async function clearRows(db: DrizzleDb, rows: readonly MarkedRow[]): Promise<number> {
  let cleared = 0;
  for (let start = 0; start < rows.length; start += BATCH) {
    const pairs = sql.join(
      rows.slice(start, start + BATCH).map(({ climbUuid, angle }) => sql`(${climbUuid}::text, ${angle}::integer)`),
      sql`, `,
    );
    const result = await db
      .update(boardClimbStats)
      .set({ benchmarkDifficulty: null })
      .where(
        and(
          eq(boardClimbStats.boardType, KILTER),
          realBenchmarkCondition(boardClimbStats.benchmarkDifficulty),
          sql`(${boardClimbStats.climbUuid}, ${boardClimbStats.angle}) IN (${pairs})`,
        ),
      );
    cleared += commandCountFromResult(result) ?? 0;
  }
  return cleared;
}

/**
 * Writes one value per target: Kilter's official grade when it gives one, else
 * whatever real value the row already holds, else its current grade. Keeping the
 * stored value is what stops a row with no official grade from rewriting every
 * hour as its crowd grade drifts, and the `IS DISTINCT FROM` guard makes a repeat
 * pass write nothing, so unchanged rows never bump `sync_seq`.
 *
 * Raw SQL because an UPDATE joined to a VALUES list has no Drizzle form.
 */
async function markRows(db: DrizzleDb, targets: readonly CuratedTarget[]): Promise<number> {
  const storedValue = sql`CASE WHEN ${realBenchmarkCondition(sql`stats.benchmark_difficulty`)} THEN stats.benchmark_difficulty END`;
  const nextValue = sql`COALESCE(upstream.official, ${storedValue}, upstream.fallback)`;
  let marked = 0;
  for (let start = 0; start < targets.length; start += BATCH) {
    const values = sql.join(
      targets
        .slice(start, start + BATCH)
        .map(
          ({ climbUuid, angle, officialDifficulty, upstreamDifficulty }) =>
            sql`(${climbUuid}::text, ${angle}::integer, ${officialDifficulty}::double precision, ${upstreamDifficulty}::double precision)`,
        ),
      sql`, `,
    );
    const result = await db.execute(sql`
      UPDATE board_climb_stats AS stats
      SET benchmark_difficulty = ${nextValue}
      FROM (VALUES ${values}) AS upstream (climb_uuid, angle, official, fallback), board_climbs AS climb
      WHERE stats.board_type = ${KILTER}
        AND stats.climb_uuid = upstream.climb_uuid
        AND stats.angle = upstream.angle
        AND climb.uuid = stats.climb_uuid
        AND climb.user_id IS NULL
        AND ${nextValue} IS NOT NULL
        AND ${nextValue} IS DISTINCT FROM stats.benchmark_difficulty
    `);
    marked += commandCountFromResult(result) ?? 0;
  }
  return marked;
}

export async function applyCuratedBenchmarks(args: {
  db: DrizzleDb;
  write: CatalogWriteRunner;
  stats: readonly KilterCuratedStat[];
  deletedLowerUuids: ReadonlySet<string> | null;
  log: (message: string) => void;
  minAngleRows?: number;
}): Promise<CuratedBenchmarkReport> {
  const { db, write, stats, deletedLowerUuids, log, minAngleRows = MIN_CURATED_ANGLE_ROWS } = args;
  const rows = foldCuratedStats(stats, deletedLowerUuids);
  const canonicalByLowerUuid = rows.length > 0 ? await loadCanonicalByLowerUuid(db, rows) : new Map<string, string>();
  const { targets, unresolvedClimbs } = buildCuratedTargets(rows, canonicalByLowerUuid);
  const report: CuratedBenchmarkReport = {
    listed: rows.length,
    resolved: targets.length,
    unresolvedClimbs,
    marked: 0,
    cleared: 0,
    refused: false,
  };

  if (targets.length < minAngleRows) {
    report.refused = true;
    log(
      `[kilter-catalog] REFUSING Verified marks: list resolved to ${targets.length} rows, under the floor of ${minAngleRows} — marks left as they are`,
    );
    return report;
  }

  // Throws until the migration that freezes Aurora's grades has run, which rolls
  // nothing back because nothing has been written. The worker can deploy ahead of
  // that migration, and marking first would lose the grades it is there to keep.
  await db.select({ climbUuid: kilterAuroraBenchmarks.climbUuid }).from(kilterAuroraBenchmarks).limit(1);

  const toClear = planCuratedClears(await loadMarkedRows(db), targets);
  await write(async (transaction) => {
    report.cleared = await clearRows(transaction, toClear);
    report.marked = await markRows(transaction, targets);
  });
  log(
    `[kilter-catalog] Verified marks: ${report.marked} marked, ${report.cleared} cleared (${report.resolved} of ${report.listed} listed rows resolved, ${unresolvedClimbs} climbs not in Boardsesh)`,
  );
  return report;
}
