import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { sql, eq, and, isNull, inArray } from 'drizzle-orm';
import { CLIMB_CHARACTERISTICS, isMethodCharacteristic } from '@boardsesh/shared-schema/characteristics';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../schema/boards/unified.js';
import { mergeCatalogCharacteristicsSql } from '../queries/climbs/catalog-characteristics.js';
import { blendedQualityAverageSql } from '../queries/climb-stats/quality-blend.js';
import { populateMoonBoardRequiredSetIds } from '../queries/climbs/moonboard-set-ids.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  HOLDSETUP_TO_LAYOUT,
  buildExistingCatalogMatchIndex,
  catalogAliasConflictUpdate,
  type MoonBoardCatalogFile,
} from './moonboard-catalog-helpers.js';
import { stageCatalogBatch } from './moonboard-catalog-batch.js';
export type { MoonBoardCatalogFile } from './moonboard-catalog-helpers.js';
const BATCH_SIZE = 2000;
const ROLLBACK = new Error('moonboard_dry_run');
export type ImportOptions = { dryRun?: boolean; beforeCommit?: (tx: postgres.TransactionSql) => Promise<void> };

async function buildExistingIndex(
  client: postgres.Sql | postgres.TransactionSql,
  db: ReturnType<typeof drizzle>,
): Promise<{
  index: ReturnType<typeof buildExistingCatalogMatchIndex>;
  climbUuids: Set<string>;
  canonicalByAlias: Map<string, string>;
  layoutsByUuid: Map<string, number>;
}> {
  const fingerprintByUuid = new Map<string, string>();
  let currentUuid: string | null = null;
  let currentHolds: { holdId: number; holdState: string }[] = [];
  const flush = () => {
    if (currentUuid !== null) fingerprintByUuid.set(currentUuid, fingerprintFromHolds(currentHolds));
  };
  const holdCursor = client<{ climb_uuid: string; hold_id: number; hold_state: string }[]>`
    SELECT climb_uuid, hold_id, hold_state
    FROM board_climb_holds
    WHERE board_type = 'moonboard'
    ORDER BY climb_uuid
  `.cursor(50000);
  for await (const rows of holdCursor) {
    for (const row of rows) {
      if (row.climb_uuid !== currentUuid) {
        flush();
        currentUuid = row.climb_uuid;
        currentHolds = [];
      }
      currentHolds.push({ holdId: row.hold_id, holdState: row.hold_state });
    }
  }
  flush();

  // user_id IS NULL fences out Boardsesh-native user climbs, matching the
  // same fence the moonboard_angle_dedup_backfill migration (#3849) applies. Without it, a user climb that
  // happens to share holds with an incoming catalog problem could be adopted
  // as the merge target, after which the catalog import would upsert its
  // stats onto the user's climb and point the problem's aliases at it.
  const climbRows = await db
    .select({
      uuid: boardClimbs.uuid,
      layoutId: boardClimbs.layoutId,
      name: boardClimbs.name,
      isListed: boardClimbs.isListed,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, 'moonboard'), isNull(boardClimbs.userId)));

  const aliasRows = await db
    .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(eq(boardClimbAliases.boardType, 'moonboard'));
  const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));
  const index = buildExistingCatalogMatchIndex(climbRows, fingerprintByUuid, canonicalByAlias);
  fingerprintByUuid.clear();
  return {
    index,
    climbUuids: new Set(climbRows.map((row) => row.uuid)),
    canonicalByAlias,
    layoutsByUuid: new Map(climbRows.map((row) => [row.uuid, row.layoutId])),
  };
}

/** Applies one complete board and its sync checkpoint in the same transaction. */
export async function applyMoonBoardCatalog(
  client: postgres.Sql,
  dump: MoonBoardCatalogFile,
  options: ImportOptions = {},
) {
  const layoutId = HOLDSETUP_TO_LAYOUT[dump.holdsetup];
  if (!layoutId || dump.count !== dump.problems.length) throw new Error('Invalid MoonBoard catalog');
  let report: Record<string, number> = {};
  try {
    await client.begin(async (connection) => {
      const tx = drizzle(Object.assign(connection, { options: client.options }) as unknown as postgres.Sql);
      // Transaction-scoped locking works with poolers and never leaks session locks.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('moonboard-catalog-import'))`);
      const {
        index: existingIndex,
        climbUuids: existingClimbUuids,
        canonicalByAlias,
        layoutsByUuid,
      } = await buildExistingIndex(connection, tx);
      const {
        climbs: climbRecords,
        stats: statsRecords,
        holds: holdsRecords,
        aliases: aliasRecords,
        withdrawnClimbUuids,
        counters,
      } = stageCatalogBatch({ problems: dump.problems, layoutId, existingIndex, existingClimbUuids, canonicalByAlias });
      let unlistedThisFile = 0;
      // Climbs — for matched rows the identity columns are already correct, so
      // refresh only the method-derived fields (characteristics/description).
      for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbs)
          .values(climbRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: boardClimbs.uuid,
            setWhere: isNull(boardClimbs.userId),
            set: {
              characteristics: mergeCatalogCharacteristicsSql(
                boardClimbs.characteristics,
                sql`excluded.characteristics`,
                Object.values(CLIMB_CHARACTERISTICS).filter(isMethodCharacteristic),
              ),
              description: sql`excluded.description`,
            },
          });
      }

      // Stats — monotonic merge: take the new grade/benchmark, but never null
      // out an existing grade/quality or shrink the upstream count. The total is
      // rebuilt as upstream + existing Boardsesh, so re-running the import repairs
      // any climb whose count was previously clobbered by a tick recompute without
      // dropping the ticks it has since accrued.
      //
      // The NEW upstream count this upsert resolves to: monotonic GREATEST of the
      // stored and incoming snapshot. Defined ONCE and reused for the count SET,
      // the total, AND the blend weight — a SET expression reads the OLD value of
      // a bare column, so the blend must weight by this NEW resolved count. Single
      // source keeps the three in lockstep if the count policy ever changes.
      const resolvedUpstreamAscensionistCount = sql`greatest(coalesce(excluded.upstream_ascensionist_count, 0), coalesce(${boardClimbStats.upstreamAscensionistCount}, 0))`;
      const blendedQuality = blendedQualityAverageSql({
        upstreamQualityAverage: sql`coalesce(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
        upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
        boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
        boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
      });
      for (let i = 0; i < statsRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbStats)
          .values(statsRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
            // Existing-side refs must be table-qualified — a bare column name is
            // ambiguous between the target row and `excluded` in ON CONFLICT.
            set: {
              displayDifficulty: sql`coalesce(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
              benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
              difficultyAverage: sql`coalesce(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
              upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
              ascensionistCount: sql`${resolvedUpstreamAscensionistCount} + coalesce(${boardClimbStats.boardseshAscensionistCount}, 0)`,
              // Manufacturer average lands in upstream_quality_average; quality_average
              // is the blend of it and Boardsesh's own votes.
              upstreamQualityAverage: sql`coalesce(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
              qualityAverage: blendedQuality,
              qualityNormalized: sql`true`,
              upstreamSyncedAt: sql`excluded.upstream_synced_at`,
            },
          });
      }

      for (let i = 0; i < holdsRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbHolds)
          .values(holdsRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoNothing();
      }

      // Self-aliases so resolveCanonicalClimbUuid always hits, plus id-based
      // aliases (moonboard:{id}:{angle} → canonical) so problem-id lookups from
      // the logbook importer resolve merged/legacy climbs.
      for (let i = 0; i < aliasRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbAliases)
          .values(aliasRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
            set: catalogAliasConflictUpdate(),
          });
      }

      // Stop listing climbs whose problem upstream has withdrawn. Rows,
      // holds, aliases, ticks and beta links all stay — the climb just leaves
      // search, matching what the MoonBoard app itself shows.
      //
      // `user_id IS NULL` is the same fence buildExistingIndex applies: a
      // Boardsesh-native climb is never collateral, even if a withdrawn
      // problem's alias chain somehow pointed at one. The IS DISTINCT FROM
      // predicate makes a re-run a no-op instead of rewriting rows that are
      // already unlisted, so the returned count is "what actually changed".
      for (let i = 0; i < withdrawnClimbUuids.length; i += BATCH_SIZE) {
        const unlistedRows = await tx
          .update(boardClimbs)
          .set({ isListed: false })
          .where(
            and(
              eq(boardClimbs.boardType, 'moonboard'),
              isNull(boardClimbs.userId),
              inArray(boardClimbs.uuid, withdrawnClimbUuids.slice(i, i + BATCH_SIZE)),
              sql`${boardClimbs.isListed} IS DISTINCT FROM false`,
            ),
          )
          .returning({ uuid: boardClimbs.uuid });
        unlistedThisFile += unlistedRows.length;
      }

      for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
        await populateMoonBoardRequiredSetIds(
          tx,
          climbRecords.slice(i, i + BATCH_SIZE).map((row) => row.uuid),
        );
      }
      const present = new Set([...aliasRecords.map((row) => row.canonicalUuid), ...withdrawnClimbUuids]);
      const absentFromSnapshot = [...layoutsByUuid].filter(
        ([uuid, layout]) => layout === layoutId && !present.has(uuid),
      ).length;
      report = { ...counters, unlisted: unlistedThisFile, absentFromSnapshot };
      await options.beforeCommit?.(connection);
      if (options.dryRun) throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return report;
}
