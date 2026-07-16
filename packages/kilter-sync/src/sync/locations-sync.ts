import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  resolveKilterInstallConfig,
  toLocationSyncLogger,
  type LocationSyncSummary,
  type PublicBoardLocationInput,
  type SizeEdgesInput,
  upsertPublicBoardLocations,
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
