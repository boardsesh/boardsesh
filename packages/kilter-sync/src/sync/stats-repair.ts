import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbAliases, boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { commandCountFromResult, rowsFromResult } from '@boardsesh/db/client';

import type { KilterTokenProvider } from '../api/token-provider';
import { fetchLayoutClimbStats } from '../api/kilter-rest';
import { KilterApiError } from '../api/errors';
import { pullKilterReference, type KilterReferencePull } from './reference-pull';
import { buildLayoutResolver } from './layout-resolver';
import { catalogStatSourceKey, foldCatalogStat, type StatAccum } from './catalog-sync';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';
const BATCH = 1000;
const TOP_LIMIT = 10;

type TokenState = { provider: KilterTokenProvider; token: string };

export type KilterStatsRepairArgs = {
  db: DrizzleDb;
  tokenProvider: KilterTokenProvider;
  apply?: boolean;
  log?: (message: string) => void;
  reference?: KilterReferencePull;
  layoutUuids?: string[];
};

export type KilterStatsRepairTopRow = {
  name: string | null;
  climbUuid: string;
  angle: number;
  ascensionistCount: number;
  auroraAscensionistCount: number | null;
  kilterAscensionistCount: number | null;
  boardseshAscensionistCount: number | null;
};

export type KilterStatsRepairSummary = {
  applied: boolean;
  gripsLayoutsProcessed: number;
  layoutsUnmapped: number;
  statsSeen: number;
  statsDeduped: number;
  statsUnresolved: number;
  canonicalStatsComputed: number;
  changedKilterRows: number;
  formulaRowsRecomputed: number;
  maxKilterDrop: number;
  maxKilterRise: number;
  topBefore: KilterStatsRepairTopRow[];
  topAfter: KilterStatsRepairTopRow[] | null;
};

type RepairStatValue = {
  boardType: string;
  climbUuid: string;
  angle: number;
  displayDifficulty: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  qualityNormalized: boolean;
  faUsername: string | null;
  faAt: string | null;
  kilterAscensionistCount: number;
  ascensionistCount: number;
};

type CompareRow = {
  changed_rows: number | string | null;
  max_drop: number | string | null;
  max_rise: number | string | null;
};

type FormulaCountRow = {
  rows_to_recompute: number | string | null;
};

type TopRow = {
  name: string | null;
  climb_uuid: string;
  angle: number | string;
  ascensionist_count: number | string | null;
  aurora_ascensionist_count: number | string | null;
  kilter_ascensionist_count: number | string | null;
  boardsesh_ascensionist_count: number | string | null;
};

async function processBatches<T>(rows: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await fn(rows.slice(i, i + BATCH));
  }
}

async function withToken<T>(state: TokenState, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(state.token);
  } catch (error) {
    if (error instanceof KilterApiError && error.code === 'unauthorized') {
      state.token = await state.provider();
      return await call(state.token);
    }
    throw error;
  }
}

function mapTopRow(row: TopRow): KilterStatsRepairTopRow {
  return {
    name: row.name,
    climbUuid: row.climb_uuid,
    angle: Number(row.angle),
    ascensionistCount: Number(row.ascensionist_count ?? 0),
    auroraAscensionistCount: row.aurora_ascensionist_count === null ? null : Number(row.aurora_ascensionist_count),
    kilterAscensionistCount: row.kilter_ascensionist_count === null ? null : Number(row.kilter_ascensionist_count),
    boardseshAscensionistCount:
      row.boardsesh_ascensionist_count === null ? null : Number(row.boardsesh_ascensionist_count),
  };
}

async function loadTopStats(db: DrizzleDb): Promise<KilterStatsRepairTopRow[]> {
  const rows = rowsFromResult<TopRow>(
    await db.execute(sql`
      SELECT bc.name,
             bcs.climb_uuid,
             bcs.angle,
             bcs.ascensionist_count,
             bcs.aurora_ascensionist_count,
             bcs.kilter_ascensionist_count,
             bcs.boardsesh_ascensionist_count
        FROM board_climb_stats bcs
        JOIN board_climbs bc
          ON bc.uuid = bcs.climb_uuid
         AND bc.board_type = bcs.board_type
       WHERE bcs.board_type = ${KILTER}
       ORDER BY bcs.ascensionist_count DESC NULLS LAST
       LIMIT ${TOP_LIMIT}
    `),
  );
  return rows.map(mapTopRow);
}

// Maps every source climb UUID (lowercased) to its canonical UUID for one board
// layout, from board_climbs self-rows + persisted board_climb_aliases. Precondition:
// run after a catalog sync has persisted this run's fingerprint aliases — the repair
// reads only persisted aliases, it does not re-derive fingerprints. A source UUID
// with no mapping here is counted in summary.statsUnresolved (observable, not silent).
async function loadCanonicalMap(db: DrizzleDb, layoutId: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const climbRows = await db
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, KILTER), eq(boardClimbs.layoutId, layoutId)));

  for (const row of climbRows) {
    map.set(row.uuid.toLowerCase(), row.uuid);
  }

  const aliasRows = await db
    .select({
      aliasUuid: boardClimbAliases.aliasUuid,
      canonicalUuid: boardClimbAliases.canonicalUuid,
    })
    .from(boardClimbAliases)
    .innerJoin(
      boardClimbs,
      and(
        eq(boardClimbs.boardType, boardClimbAliases.boardType),
        eq(boardClimbs.uuid, boardClimbAliases.canonicalUuid),
      ),
    )
    .where(and(eq(boardClimbAliases.boardType, KILTER), eq(boardClimbs.layoutId, layoutId)));

  for (const row of aliasRows) {
    map.set(row.aliasUuid.toLowerCase(), row.canonicalUuid);
  }

  return map;
}

function statValueFromAccum(accum: StatAccum): RepairStatValue {
  return {
    boardType: KILTER,
    climbUuid: accum.canonicalUuid,
    angle: accum.angle,
    displayDifficulty: accum.displayDifficulty,
    difficultyAverage: accum.difficultyAverage,
    qualityAverage: accum.qualityAverage,
    qualityNormalized: true,
    faUsername: accum.faUsername,
    faAt: accum.faAt,
    kilterAscensionistCount: accum.kilterCount,
    ascensionistCount: accum.kilterCount,
  };
}

async function compareExistingStats(
  db: DrizzleDb,
  statValues: RepairStatValue[],
): Promise<{ changedRows: number; maxKilterDrop: number; maxKilterRise: number }> {
  let changedRows = 0;
  let maxKilterDrop = 0;
  let maxKilterRise = 0;

  await processBatches(statValues, async (chunk) => {
    const incoming = chunk.map((statValue) => ({
      climb_uuid: statValue.climbUuid,
      angle: statValue.angle,
      kilter_count: statValue.kilterAscensionistCount,
    }));
    const rows = rowsFromResult<CompareRow>(
      await db.execute(sql`
        WITH incoming AS (
          SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(incoming)}::jsonb)
              AS i(climb_uuid text, angle integer, kilter_count bigint)
        )
        SELECT COUNT(*) FILTER (
                 WHERE s.kilter_ascensionist_count IS DISTINCT FROM i.kilter_count
               ) AS changed_rows,
               MAX(COALESCE(s.kilter_ascensionist_count, 0) - i.kilter_count) FILTER (
                 WHERE COALESCE(s.kilter_ascensionist_count, 0) > i.kilter_count
               ) AS max_drop,
               MAX(i.kilter_count - COALESCE(s.kilter_ascensionist_count, 0)) FILTER (
                 WHERE i.kilter_count > COALESCE(s.kilter_ascensionist_count, 0)
               ) AS max_rise
          FROM incoming i
     LEFT JOIN board_climb_stats s
            ON s.board_type = ${KILTER}
           AND s.climb_uuid = i.climb_uuid
           AND s.angle = i.angle
      `),
    );
    const row = rows[0];
    changedRows += Number(row?.changed_rows ?? 0);
    maxKilterDrop = Math.max(maxKilterDrop, Number(row?.max_drop ?? 0));
    maxKilterRise = Math.max(maxKilterRise, Number(row?.max_rise ?? 0));
  });

  return { changedRows, maxKilterDrop, maxKilterRise };
}

async function countFormulaMismatches(db: DrizzleDb): Promise<number> {
  const rows = rowsFromResult<FormulaCountRow>(
    await db.execute(sql`
      SELECT COUNT(*) AS rows_to_recompute
        FROM board_climb_stats
       WHERE board_type = ${KILTER}
         AND ascensionist_count IS DISTINCT FROM (
           GREATEST(COALESCE(kilter_ascensionist_count, 0), COALESCE(aurora_ascensionist_count, 0))
           + COALESCE(boardsesh_ascensionist_count, 0)
         )
    `),
  );
  return Number(rows[0]?.rows_to_recompute ?? 0);
}

async function upsertRepairedStats(db: DrizzleDb, statValues: RepairStatValue[]): Promise<void> {
  await processBatches(statValues, async (chunk) => {
    await db
      .insert(boardClimbStats)
      .values(chunk)
      .onConflictDoUpdate({
        target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
        set: {
          kilterAscensionistCount: sql`excluded.kilter_ascensionist_count`,
          ascensionistCount: sql`GREATEST(COALESCE(excluded.kilter_ascensionist_count, 0), COALESCE(${boardClimbStats.auroraAscensionistCount}, 0)) + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
          displayDifficulty: sql`COALESCE(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
          difficultyAverage: sql`COALESCE(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
          qualityAverage: sql`COALESCE(excluded.quality_average, ${boardClimbStats.qualityAverage})`,
          qualityNormalized: sql`true`,
          faUsername: sql`COALESCE(excluded.fa_username, ${boardClimbStats.faUsername})`,
          faAt: sql`COALESCE(excluded.fa_at, ${boardClimbStats.faAt})`,
        },
      });
  });
}

async function recomputeMaterializedTotals(db: DrizzleDb): Promise<number> {
  const result = await db.execute(sql`
    UPDATE board_climb_stats
       SET ascensionist_count = (
         GREATEST(COALESCE(kilter_ascensionist_count, 0), COALESCE(aurora_ascensionist_count, 0))
         + COALESCE(boardsesh_ascensionist_count, 0)
       )
     WHERE board_type = ${KILTER}
       AND ascensionist_count IS DISTINCT FROM (
         GREATEST(COALESCE(kilter_ascensionist_count, 0), COALESCE(aurora_ascensionist_count, 0))
         + COALESCE(boardsesh_ascensionist_count, 0)
       )
  `);
  return commandCountFromResult(result) ?? 0;
}

export async function repairKilterCatalogStats(args: KilterStatsRepairArgs): Promise<KilterStatsRepairSummary> {
  const log = args.log ?? (() => {});
  const state: TokenState = { provider: args.tokenProvider, token: await args.tokenProvider() };
  const reference = args.reference ?? (await pullKilterReference({ accessToken: state.token, log }));
  const resolver = await buildLayoutResolver(args.db);
  const wantedLayoutUuids = args.layoutUuids ? new Set(args.layoutUuids) : null;

  const byBoardLayout = new Map<number, string[]>();
  let layoutsUnmapped = 0;
  for (const layout of reference.productLayouts) {
    if (!layout.isListed) continue;
    if (wantedLayoutUuids && !wantedLayoutUuids.has(layout.productLayoutUuid)) continue;
    const layoutId = resolver.resolve(layout.productLayoutUuid, layout.productName);
    if (layoutId === null) {
      layoutsUnmapped += 1;
      continue;
    }
    const group = byBoardLayout.get(layoutId) ?? [];
    group.push(layout.productLayoutUuid);
    byBoardLayout.set(layoutId, group);
  }

  const topBefore = await loadTopStats(args.db);
  const statsByCanonicalAngle = new Map<string, StatAccum>();
  const seenSourceStats = new Set<string>();
  let statsSeen = 0;
  let statsDeduped = 0;
  let statsUnresolved = 0;
  let gripsLayoutsProcessed = 0;

  for (const [boardLayoutId, gripsLayoutUuids] of byBoardLayout) {
    const canonicalBySourceUuid = await loadCanonicalMap(args.db, boardLayoutId);
    gripsLayoutsProcessed += gripsLayoutUuids.length;
    for (const gripsLayoutUuid of gripsLayoutUuids) {
      const stats = await withToken(state, (token) => fetchLayoutClimbStats(token, gripsLayoutUuid));
      for (const stat of stats) {
        statsSeen += 1;
        const sourceKey = catalogStatSourceKey(stat);
        if (seenSourceStats.has(sourceKey)) {
          statsDeduped += 1;
          continue;
        }
        seenSourceStats.add(sourceKey);

        const canonicalUuid = canonicalBySourceUuid.get(stat.climbUuid.toLowerCase());
        if (!canonicalUuid) {
          statsUnresolved += 1;
          continue;
        }
        foldCatalogStat(statsByCanonicalAngle, stat, canonicalUuid);
      }
    }
  }

  const statValues = [...statsByCanonicalAngle.values()].map(statValueFromAccum);
  const { changedRows, maxKilterDrop, maxKilterRise } = await compareExistingStats(args.db, statValues);
  const formulaRowsBeforeApply = await countFormulaMismatches(args.db);

  let formulaRowsRecomputed = 0;
  let topAfter: KilterStatsRepairTopRow[] | null = null;
  if (args.apply) {
    // Atomic: a crash between the kilter-count overwrite and the materialized
    // recompute would otherwise leave ascensionist_count stale until re-run.
    await args.db.transaction(async (tx) => {
      await upsertRepairedStats(tx, statValues);
      formulaRowsRecomputed = await recomputeMaterializedTotals(tx);
    });
    topAfter = await loadTopStats(args.db);
  }

  return {
    applied: args.apply ?? false,
    gripsLayoutsProcessed,
    layoutsUnmapped,
    statsSeen,
    statsDeduped,
    statsUnresolved,
    canonicalStatsComputed: statValues.length,
    changedKilterRows: changedRows,
    formulaRowsRecomputed: args.apply ? formulaRowsRecomputed : formulaRowsBeforeApply,
    maxKilterDrop,
    maxKilterRise,
    topBefore,
    topAfter,
  };
}
