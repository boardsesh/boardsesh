import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { kilterWallSources, userBoards } from '@boardsesh/db/schema';
import {
  resolveKilterInstallConfig,
  toLocationSyncLogger,
  type LocationSyncSummary,
  type PublicBoardLocationInput,
  type SizeEdgesInput,
  upsertPublicBoardLocations,
  boardUuidForSource,
} from '@boardsesh/location-sync';
import type { KilterReferencePull, KilterRefGym, KilterRefProductLayout, KilterRefWall } from './reference-pull';
import type { LayoutResolver } from './layout-resolver';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type BuildKilterLocationRecordsResult = {
  records: PublicBoardLocationInput[];
  skipped: Array<{ sourceKey: string; reason: string }>;
};

function mapWallsByGym(walls: KilterRefWall[]): Map<string, KilterRefWall[]> {
  const wallsByGym = new Map<string, KilterRefWall[]>();
  for (const wall of walls) {
    if (!wall.gymUuid) {
      continue;
    }
    const existingWalls = wallsByGym.get(wall.gymUuid) ?? [];
    existingWalls.push(wall);
    wallsByGym.set(wall.gymUuid, existingWalls);
  }
  return wallsByGym;
}

function productLayoutsByUuid(productLayouts: KilterRefProductLayout[]): Map<string, KilterRefProductLayout> {
  const productLayoutMap = new Map<string, KilterRefProductLayout>();
  for (const productLayout of productLayouts) {
    productLayoutMap.set(productLayout.productLayoutUuid, productLayout);
  }
  return productLayoutMap;
}

function productLayoutEdges(productLayout: KilterRefProductLayout | undefined): SizeEdgesInput | null {
  if (!productLayout) {
    return null;
  }
  return {
    edgeLeft: productLayout.edgeLeft,
    edgeRight: productLayout.edgeRight,
    edgeBottom: productLayout.edgeBottom,
    edgeTop: productLayout.edgeTop,
  };
}

function formatLocationName(gym: KilterRefGym): string | null {
  const parts = [gym.city, gym.country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatAddress(gym: KilterRefGym): string | null {
  const parts = [gym.address, gym.city, gym.country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

function wallSourceKey(gym: KilterRefGym, wall: KilterRefWall): string {
  return `kilter:${gym.gymUuid}:${wall.wallUuid || wall.id}`;
}

/**
 * Collapse identical skip entries. A wall is processed once and skipped for a
 * single reason, so any repeat of the same (sourceKey, reason) is spurious —
 * historically from a `wall_uuid` streamed multiple times over PowerSync. The
 * reference pull now dedups at the source; this is defense-in-depth so the run
 * summary never reports the same wall twice.
 */
export function dedupeSkipped(
  skipped: Array<{ sourceKey: string; reason: string }>,
): Array<{ sourceKey: string; reason: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ sourceKey: string; reason: string }> = [];
  for (const entry of skipped) {
    // Newline can't appear in a sourceKey (`kilter:gym:wall`) or a reason string,
    // so it's an unambiguous composite-key separator.
    const key = `${entry.sourceKey}\n${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function buildKilterLocationRecords(
  reference: KilterReferencePull,
  resolver: LayoutResolver,
): BuildKilterLocationRecordsResult {
  const records: PublicBoardLocationInput[] = [];
  const skipped: Array<{ sourceKey: string; reason: string }> = [];
  const wallsByGym = mapWallsByGym(reference.walls);
  const layoutByUuid = productLayoutsByUuid(reference.productLayouts);

  for (const gym of reference.gyms) {
    const gymWalls = wallsByGym.get(gym.gymUuid) ?? [];
    if (gymWalls.length === 0) {
      continue;
    }

    if (gym.isListed !== true) {
      for (const wall of gymWalls) {
        skipped.push({ sourceKey: wallSourceKey(gym, wall), reason: 'unlisted gym' });
      }
      continue;
    }

    const gymName = gym.name || `Kilter Gym ${gym.gymUuid}`;
    const gymSourceKey = `kilter:${gym.gymUuid}`;

    for (const wall of gymWalls) {
      const sourceKey = wallSourceKey(gym, wall);
      if (wall.isListed !== true) {
        skipped.push({ sourceKey, reason: 'unlisted wall' });
        continue;
      }
      if (!wall.productName || !wall.productLayoutUuid) {
        skipped.push({ sourceKey, reason: 'missing product name or product layout' });
        continue;
      }

      const layoutId = resolver.resolve(wall.productLayoutUuid, wall.productName);
      if (layoutId == null) {
        skipped.push({ sourceKey, reason: `unmapped product layout ${wall.productLayoutUuid}` });
        continue;
      }

      const config = resolveKilterInstallConfig({
        layoutId,
        productLayoutUuid: wall.productLayoutUuid,
        productLayoutEdges: productLayoutEdges(layoutByUuid.get(wall.productLayoutUuid)),
        accumulatedHoldSetValue: wall.accumulatedHoldSetValue,
        angle: wall.angle,
        isAngleAdjustable: wall.isAdjustable === true,
      });
      if (!config) {
        skipped.push({ sourceKey, reason: `unsupported Kilter wall config ${wall.productLayoutUuid}` });
        continue;
      }

      records.push({
        ...config,
        sourceKey,
        gymSourceKey,
        name: `${gymName} - ${wall.productName}`,
        slugBase: `${gymName}-kilter`,
        locationName: formatLocationName(gym),
        latitude: gym.latitude ?? Number.NaN,
        longitude: gym.longitude ?? Number.NaN,
        gymName,
        gymAddress: formatAddress(gym),
        serialNumber: wall.serialNumber,
      });
    }
  }

  return { records, skipped: dedupeSkipped(skipped) };
}

/** One kilter_wall_sources row as the location sync resolves it (always listed). */
export type WallSourceMapping = {
  sourceKey: string;
  sourceBoardUuid: string;
  gymUuid: string;
  productLayoutUuid: string;
  wallUuid: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

const WALL_SOURCE_BATCH = 1000;

/**
 * Write this run's wall sources as listed and unlist every other one, in one
 * transaction. Rows that already hold the same values are left alone: the old
 * code unlisted all ~1.2k rows and re-upserted each one per run, so every row
 * got two new versions per pass although almost none changed. is_listed is in
 * the comparison so a row coming back after an unlisting is re-listed.
 * updated_at only moves on a real change; the one reader
 * (kilter-live-import.ts) filters on is_listed and never reads it.
 */
export async function upsertKilterWallSources(db: DrizzleDb, mappings: WallSourceMapping[]): Promise<void> {
  await db.transaction(async (transaction) => {
    for (let start = 0; start < mappings.length; start += WALL_SOURCE_BATCH) {
      const chunk = mappings.slice(start, start + WALL_SOURCE_BATCH);
      await transaction
        .insert(kilterWallSources)
        .select(wallSourceUpsertSelect(chunk))
        .onConflictDoUpdate({
          target: kilterWallSources.sourceKey,
          set: {
            sourceBoardUuid: sql`excluded.source_board_uuid`,
            gymUuid: sql`excluded.gym_uuid`,
            productLayoutUuid: sql`excluded.product_layout_uuid`,
            wallUuid: sql`excluded.wall_uuid`,
            layoutId: sql`excluded.layout_id`,
            sizeId: sql`excluded.size_id`,
            setIds: sql`excluded.set_ids`,
            isListed: sql`excluded.is_listed`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`(${kilterWallSources.sourceBoardUuid}, ${kilterWallSources.gymUuid}, ${kilterWallSources.productLayoutUuid},
              ${kilterWallSources.wallUuid}, ${kilterWallSources.layoutId}, ${kilterWallSources.sizeId},
              ${kilterWallSources.setIds}, ${kilterWallSources.isListed})
            IS DISTINCT FROM (excluded.source_board_uuid, excluded.gym_uuid, excluded.product_layout_uuid,
              excluded.wall_uuid, excluded.layout_id, excluded.size_id, excluded.set_ids, excluded.is_listed)`,
        });
    }
    const listedKeys = mappings.map((mapping) => mapping.sourceKey);
    await transaction
      .update(kilterWallSources)
      .set({ isListed: false, updatedAt: new Date() })
      .where(
        and(
          eq(kilterWallSources.isListed, true),
          sql`${kilterWallSources.sourceKey} <> ALL(${sql.param(listedKeys)}::text[])`,
        ),
      );
  });
}

/**
 * A wall-source chunk as unnest() arrays, one statement text for any chunk
 * size. Drizzle's insert().select(sql) inserts into every kilter_wall_sources
 * column in table order, so this lists them all.
 */
function wallSourceUpsertSelect(rows: WallSourceMapping[]): SQL {
  return sql`SELECT incoming.source_key, incoming.source_board_uuid, incoming.gym_uuid, incoming.product_layout_uuid,
           incoming.wall_uuid, incoming.layout_id, incoming.size_id, incoming.set_ids, true, now()
      FROM unnest(
        ${sql.param(rows.map((row) => row.sourceKey))}::text[],
        ${sql.param(rows.map((row) => row.sourceBoardUuid))}::text[],
        ${sql.param(rows.map((row) => row.gymUuid))}::text[],
        ${sql.param(rows.map((row) => row.productLayoutUuid))}::text[],
        ${sql.param(rows.map((row) => row.wallUuid))}::text[],
        ${sql.param(rows.map((row) => row.layoutId))}::integer[],
        ${sql.param(rows.map((row) => row.sizeId))}::integer[],
        ${sql.param(rows.map((row) => row.setIds))}::text[]
      ) AS incoming(source_key, source_board_uuid, gym_uuid, product_layout_uuid, wall_uuid, layout_id, size_id, set_ids)`;
}

export async function syncKilterLocations(args: {
  db: DrizzleDb;
  reference: KilterReferencePull;
  resolver: LayoutResolver;
  log?: (message: string) => void;
}): Promise<LocationSyncSummary> {
  const { records, skipped } = buildKilterLocationRecords(args.reference, args.resolver);
  const summary = await upsertPublicBoardLocations(args.db, records, {
    logger: toLocationSyncLogger(args.log),
  });
  // Persist selectors from the reference snapshot, never reconstruct a wall
  // from layout/serial alone. Keep source rows so merge tombstones still resolve.
  const validRecords = records.filter(
    (record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude),
  );
  const boardUuids = validRecords.map((record) => boardUuidForSource(record.sourceKey));
  const existingBoards = boardUuids.length
    ? await args.db.select({ uuid: userBoards.uuid }).from(userBoards).where(inArray(userBoards.uuid, boardUuids))
    : [];
  const existingUuids = new Set(existingBoards.map((board) => board.uuid));
  const wallsByKey = new Map(
    args.reference.walls
      .filter((wall) => wall.gymUuid)
      .map((wall) => [`kilter:${wall.gymUuid}:${wall.wallUuid || wall.id}`, wall]),
  );
  // Keyed by source key so a repeated wall can't hit the same row twice in one
  // INSERT … ON CONFLICT (Postgres rejects that); the last record wins, as the
  // old one-row-per-statement loop did.
  const mappingsByKey = new Map<string, WallSourceMapping>();
  for (const record of validRecords) {
    const wall = wallsByKey.get(record.sourceKey);
    const sourceBoardUuid = boardUuidForSource(record.sourceKey);
    if (!existingUuids.has(sourceBoardUuid) || !wall?.gymUuid || !wall.productLayoutUuid) continue;
    mappingsByKey.set(record.sourceKey, {
      sourceKey: record.sourceKey,
      sourceBoardUuid,
      gymUuid: wall.gymUuid,
      productLayoutUuid: wall.productLayoutUuid,
      wallUuid: wall.wallUuid || wall.id,
      layoutId: record.layoutId,
      sizeId: record.sizeId,
      setIds: record.setIds,
    });
  }
  await upsertKilterWallSources(args.db, [...mappingsByKey.values()]);
  // Merge the upsert-side skips (e.g. invalid coordinates) with the kilter-side
  // skips (unlisted / unmapped / unsupported) and dedupe — boardsSkipped tracks
  // the deduped length so the count and the array stay in step.
  const mergedSkipped = dedupeSkipped([...summary.skipped, ...skipped]);
  const mergedSummary = {
    ...summary,
    boardsSkipped: mergedSkipped.length,
    skipped: mergedSkipped,
  };
  args.log?.(
    `[kilter-locations] upserted ${mergedSummary.boardsUpserted}/${mergedSummary.boardsSeen} board(s), ${mergedSummary.gymsUpserted} gym(s), skipped ${mergedSummary.boardsSkipped}`,
  );
  return mergedSummary;
}
