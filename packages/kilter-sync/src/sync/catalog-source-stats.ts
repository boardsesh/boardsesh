import { and, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardClimbStats,
  kilterCatalogDeferred,
  kilterCatalogSourceStats,
} from '@boardsesh/db/schema';
import type { KilterCatalogStat } from '../api/kilter-rest';
import {
  catalogStatSourceKey,
  foldCatalogStat,
  shouldSkipEmptyCatalogStat,
  type CatalogWriteRunner,
  type StatAccum,
} from './catalog-sync';
import { upsertKilterStats, type KilterStatsUpsertRow } from './stats-upsert';

type CatalogDatabase = Parameters<Parameters<CatalogWriteRunner>[0]>[0];
export type CatalogSourceStat = { stat: KilterCatalogStat; canonicalUuid: string };
export type CatalogSourceStatsOptions = {
  /** Only complete, current scope coverage can authorize decreases. */
  completeCoverage: boolean;
  /** Minimum confirmed request-start watermark across all contributing scopes. */
  confirmedAt?: string | null;
  scopeKey?: string;
  generation?: string;
  /** Incremental daily restamp only; full/weekly reconciliation replays every key. */
  freshnessOnly?: boolean;
};
export type CatalogSourceStatsResult = { sent: number; written: number };
const BATCH = 500;

function canonicalAngleKey(canonicalUuid: string, angle: number): string {
  // Canonical keys retain their stored casing; only upstream source IDs normalize.
  return `${canonicalUuid}|${angle}`;
}

function validateSourceStat(entry: CatalogSourceStat): void {
  const statistic = entry.stat;
  if (
    typeof entry.canonicalUuid !== 'string' ||
    entry.canonicalUuid.length === 0 ||
    typeof statistic.climbUuid !== 'string' ||
    statistic.climbUuid.length === 0 ||
    !Number.isSafeInteger(statistic.angle) ||
    !Number.isSafeInteger(statistic.ascentCount) ||
    statistic.ascentCount < 0 ||
    [statistic.currentDifficultyId, statistic.difficultyAverage, statistic.qualityAverage].some(
      (field) => field != null && !Number.isFinite(field),
    ) ||
    [statistic.faUsername, statistic.faAt].some((field) => field != null && typeof field !== 'string')
  )
    throw new Error('Malformed Kilter source statistic');
}

/** Last response for a source/angle replaces its absolute count, never adds to it. */
export function dedupeCatalogSourceStats(entries: CatalogSourceStat[]): CatalogSourceStat[] {
  const bySource = new Map<string, CatalogSourceStat>();
  const canonicalBySourceUuid = new Map<string, string>();
  for (const entry of entries) {
    validateSourceStat(entry);
    const sourceKey = catalogStatSourceKey(entry.stat);
    const sourceUuid = entry.stat.climbUuid.toLowerCase();
    const previousCanonical = canonicalBySourceUuid.get(sourceUuid);
    if (previousCanonical !== undefined && previousCanonical !== entry.canonicalUuid) {
      throw new Error(`Conflicting Kilter source mapping: ${sourceKey}`);
    }
    canonicalBySourceUuid.set(sourceUuid, entry.canonicalUuid);
    bySource.set(sourceKey, {
      canonicalUuid: entry.canonicalUuid,
      stat: {
        ...entry.stat,
        climbUuid: entry.stat.climbUuid.toLowerCase(),
        currentDifficultyId: entry.stat.currentDifficultyId ?? null,
        difficultyAverage: entry.stat.difficultyAverage ?? null,
        qualityAverage: entry.stat.qualityAverage ?? null,
        faUsername: entry.stat.faUsername ?? null,
        faAt: entry.stat.faAt ?? null,
      },
    });
  }
  return [...bySource.values()];
}

/** Deterministic fallback grades, with the canonical's own source always preferred. */
export function aggregateCatalogSourceStats(entries: CatalogSourceStat[]): Map<string, StatAccum> {
  const accumulated = new Map<string, StatAccum>();
  const ordered = dedupeCatalogSourceStats(entries).sort((left, right) =>
    catalogStatSourceKey(left.stat).localeCompare(catalogStatSourceKey(right.stat)),
  );
  for (const entry of ordered) foldCatalogStat(accumulated, entry.stat, entry.canonicalUuid);
  return accumulated;
}

function toUpsertRow(accumulated: StatAccum): KilterStatsUpsertRow {
  return {
    climbUuid: accumulated.canonicalUuid,
    angle: accumulated.angle,
    displayDifficulty: accumulated.displayDifficulty,
    difficultyAverage: accumulated.difficultyAverage,
    qualityAverage: accumulated.qualityAverage,
    faUsername: accumulated.faUsername,
    faAt: accumulated.faAt,
    upstreamAscensionistCount: accumulated.kilterCount,
  };
}

async function recomputeCachedKeys(
  transaction: CatalogDatabase,
  affected: Map<string, { canonicalUuid: string; angle: number }>,
  options: CatalogSourceStatsOptions,
): Promise<CatalogSourceStatsResult> {
  const canonicalUuids = [...new Set([...affected.values()].map((entry) => entry.canonicalUuid))];
  if (canonicalUuids.length === 0) return { sent: 0, written: 0 };
  const cached = await transaction
    .select({ canonicalUuid: kilterCatalogSourceStats.canonicalUuid, stat: kilterCatalogSourceStats.payload })
    .from(kilterCatalogSourceStats)
    .where(inArray(kilterCatalogSourceStats.canonicalUuid, canonicalUuids));
  const accumulated = aggregateCatalogSourceStats(
    cached.filter((entry) => affected.has(canonicalAngleKey(entry.canonicalUuid, entry.stat.angle))),
  );
  // Preserve an explicitly affected existing key even if it has no cached
  // contributors, while keeping tick grades, counts and quality in the upsert.
  for (const [key, entry] of affected) {
    if (!accumulated.has(key)) {
      foldCatalogStat(
        accumulated,
        {
          climbUuid: entry.canonicalUuid,
          angle: entry.angle,
          ascentCount: 0,
          currentDifficultyId: null,
          difficultyAverage: null,
          qualityAverage: null,
          faUsername: null,
          faAt: null,
        },
        entry.canonicalUuid,
      );
    }
  }
  const empty = [...accumulated.values()].filter(shouldSkipEmptyCatalogStat);
  const existingEmptyKeys = new Set<string>();
  if (empty.length > 0) {
    const existing = await transaction
      .select({ canonicalUuid: boardClimbStats.climbUuid, angle: boardClimbStats.angle })
      .from(boardClimbStats)
      .where(and(eq(boardClimbStats.boardType, 'kilter'), inArray(boardClimbStats.climbUuid, canonicalUuids)));
    for (const entry of existing) existingEmptyKeys.add(canonicalAngleKey(entry.canonicalUuid, entry.angle));
  }
  const rows = [...accumulated.values()]
    .filter(
      (entry) =>
        !shouldSkipEmptyCatalogStat(entry) ||
        existingEmptyKeys.has(canonicalAngleKey(entry.canonicalUuid, entry.angle)),
    )
    .map(toUpsertRow);
  const protectedCanonicals = new Set<string>();
  if (options.completeCoverage) {
    const activeDeferred = transaction
      .select({ sourceUuid: kilterCatalogDeferred.sourceUuid })
      .from(kilterCatalogDeferred)
      .where(ne(kilterCatalogDeferred.reason, 'resolved'));
    // A changed source with old geometry is quarantined. Its absent cache row
    // cannot make a partial contributor sum authoritative for that canonical.
    const aliasMappings = await transaction
      .select({ canonicalUuid: boardClimbAliases.canonicalUuid })
      .from(boardClimbAliases)
      .where(
        and(
          eq(boardClimbAliases.boardType, 'kilter'),
          inArray(boardClimbAliases.canonicalUuid, canonicalUuids),
          inArray(sql`lower(${boardClimbAliases.aliasUuid})`, activeDeferred),
        ),
      );
    const ownMappings = await transaction
      .select({ canonicalUuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.boardType, 'kilter'),
          inArray(boardClimbs.uuid, canonicalUuids),
          inArray(sql`lower(${boardClimbs.uuid})`, activeDeferred),
        ),
      );
    for (const entry of [...aliasMappings, ...ownMappings]) protectedCanonicals.add(entry.canonicalUuid);
  }
  let written = 0;
  for (const authoritative of [true, false]) {
    const matching = rows.filter(
      (entry) => (options.completeCoverage && !protectedCanonicals.has(entry.climbUuid)) === authoritative,
    );
    if (matching.length === 0) continue;
    written += await upsertKilterStats(transaction, matching, {
      policy: authoritative ? 'authoritative' : 'raise-only',
      syncedAt: authoritative ? (options.confirmedAt ?? null) : null,
    });
  }
  return { sent: rows.length, written };
}

/**
 * Caller MUST pass its lease/fence transaction. Cache replacements and every
 * aggregate derived from them commit together; a failed aggregate rolls back
 * its source updates. No absence in a delta removes a cached contributor.
 */
export async function applyCatalogSourceStats(
  transaction: CatalogDatabase,
  entries: CatalogSourceStat[],
  options: CatalogSourceStatsOptions,
): Promise<CatalogSourceStatsResult> {
  const unique = dedupeCatalogSourceStats(entries);
  if (unique.length === 0) return { sent: 0, written: 0 };
  const previous = await transaction
    .select({
      sourceUuid: kilterCatalogSourceStats.sourceUuid,
      canonicalUuid: kilterCatalogSourceStats.canonicalUuid,
      angle: kilterCatalogSourceStats.angle,
    })
    .from(kilterCatalogSourceStats)
    .where(
      inArray(
        kilterCatalogSourceStats.sourceUuid,
        unique.map((entry) => entry.stat.climbUuid),
      ),
    );
  const affected = new Map<string, { canonicalUuid: string; angle: number }>();
  const incomingBySource = new Map(unique.map((entry) => [catalogStatSourceKey(entry.stat), entry]));
  const incomingCanonicalBySourceUuid = new Map(unique.map((entry) => [entry.stat.climbUuid, entry.canonicalUuid]));
  for (const entry of previous) {
    const sourceKey = `${entry.sourceUuid}|${entry.angle}`;
    const incoming = incomingBySource.get(sourceKey);
    const incomingCanonical = incomingCanonicalBySourceUuid.get(entry.sourceUuid);
    if (incomingCanonical !== undefined && incomingCanonical !== entry.canonicalUuid) {
      throw new Error(`Kilter source canonical mapping conflict: ${sourceKey}`);
    }
    if (incoming) {
      affected.set(canonicalAngleKey(entry.canonicalUuid, entry.angle), entry);
    }
  }
  for (const entry of unique) {
    affected.set(canonicalAngleKey(entry.canonicalUuid, entry.stat.angle), {
      canonicalUuid: entry.canonicalUuid,
      angle: entry.stat.angle,
    });
  }
  await transaction
    .insert(kilterCatalogSourceStats)
    .values(
      unique.map((entry) => ({
        sourceUuid: entry.stat.climbUuid,
        angle: entry.stat.angle,
        canonicalUuid: entry.canonicalUuid,
        payload: entry.stat,
        scopeKey: options.scopeKey ?? '',
        generation: options.generation ?? '',
      })),
    )
    .onConflictDoUpdate({
      target: [kilterCatalogSourceStats.sourceUuid, kilterCatalogSourceStats.angle],
      set: {
        canonicalUuid: sql`excluded.canonical_uuid`,
        payload: sql`excluded.payload`,
        scopeKey: sql`excluded.scope_key`,
        generation: sql`excluded.generation`,
        updatedAt: sql`clock_timestamp()`,
      },
    });
  return recomputeCachedKeys(transaction, affected, options);
}

/** Weekly reconciliation and daily freshness use the same cache, with no download. */
export async function replayCachedCatalogStats(
  db: CatalogDatabase,
  write: CatalogWriteRunner,
  options: CatalogSourceStatsOptions,
): Promise<CatalogSourceStatsResult> {
  // Unchanged rows need freshness only where Boardsesh ascents still await
  // upstream absorption. Keep the 15-minute path away from the full cache.
  const canonicals = options.freshnessOnly
    ? options.confirmedAt
      ? await db
          .selectDistinct({ canonicalUuid: boardClimbStats.climbUuid })
          .from(boardClimbStats)
          .where(
            and(
              eq(boardClimbStats.boardType, 'kilter'),
              gt(boardClimbStats.boardseshAscensionistCount, 0),
              or(
                isNull(boardClimbStats.upstreamSyncedAt),
                lt(
                  boardClimbStats.upstreamSyncedAt,
                  new Date(Date.parse(options.confirmedAt) - 24 * 60 * 60_000).toISOString(),
                ),
              ),
            ),
          )
      : []
    : await db.selectDistinct({ canonicalUuid: kilterCatalogSourceStats.canonicalUuid }).from(kilterCatalogSourceStats);
  const result: CatalogSourceStatsResult = { sent: 0, written: 0 };
  for (let start = 0; start < canonicals.length; start += BATCH) {
    const canonicalUuids = canonicals.slice(start, start + BATCH).map((entry) => entry.canonicalUuid);
    const batch = await write(async (transaction) => {
      const keys = await transaction
        .select({ canonicalUuid: kilterCatalogSourceStats.canonicalUuid, angle: kilterCatalogSourceStats.angle })
        .from(kilterCatalogSourceStats)
        .where(inArray(kilterCatalogSourceStats.canonicalUuid, canonicalUuids));
      const affected = new Map(keys.map((entry) => [canonicalAngleKey(entry.canonicalUuid, entry.angle), entry]));
      return recomputeCachedKeys(transaction, affected, options);
    });
    result.sent += batch.sent;
    result.written += batch.written;
  }
  return result;
}

/**
 * Only after every full endpoint and its overlapping delta is durable may a
 * missing source's old count become zero. Deferred geometry retains its last
 * safe contribution; no new geometry statistics are attached to that row.
 */
export async function finalizeCatalogSourceBaseline(
  db: CatalogDatabase,
  write: CatalogWriteRunner,
  generation: string,
  options: CatalogSourceStatsOptions = { completeCoverage: false },
): Promise<CatalogSourceStatsResult> {
  const result: CatalogSourceStatsResult = { sent: 0, written: 0 };
  for (;;) {
    const stale = await db
      .select()
      .from(kilterCatalogSourceStats)
      .where(
        and(
          ne(kilterCatalogSourceStats.generation, generation),
          notInArray(
            kilterCatalogSourceStats.sourceUuid,
            db
              .select({ sourceUuid: kilterCatalogDeferred.sourceUuid })
              .from(kilterCatalogDeferred)
              .where(ne(kilterCatalogDeferred.reason, 'resolved')),
          ),
        ),
      )
      .limit(BATCH);
    if (stale.length === 0) return result;
    const batch = await write((transaction) =>
      applyCatalogSourceStats(
        transaction,
        stale.map((entry) => ({ canonicalUuid: entry.canonicalUuid, stat: { ...entry.payload, ascentCount: 0 } })),
        { ...options, completeCoverage: false, confirmedAt: null, generation },
      ),
    );
    result.sent += batch.sent;
    result.written += batch.written;
  }
}
