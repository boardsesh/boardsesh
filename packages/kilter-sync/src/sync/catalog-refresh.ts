import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  boardClimbs,
  boardClimbAliases,
  boardPlacements,
  kilterCatalogDeferred,
  kilterCatalogSourceStats,
} from '@boardsesh/db/schema';
import { KilterApiError } from '../api/errors';
import {
  fetchCatalogDelta,
  fetchLayoutClimbs,
  fetchLayoutClimbStats,
  type KilterCatalogClimb,
  type KilterCatalogStat,
  type KilterCatalogDeltaRecord,
} from '../api/kilter-rest';
import { pullKilterReference, type KilterRefProductLayout } from './reference-pull';
import { decodeGripsClimbConcat, findUniqueDecodableLayout } from './catalog-parse';
import type { CatalogWriteRunner } from './catalog-sync';
import { buildLayoutResolver } from './layout-resolver';
import { syncFullKilterCatalog, type SyncKilterCatalogArgs, type KilterCatalogSummary } from './catalog-sync';
import {
  withCatalogWriterLease,
  catalogMappingVersion,
  catalogDeltaSince,
  readCatalogCheckpoint,
  startCatalogBaseline,
  completeCatalogCheckpoint,
  type CatalogScope,
} from './catalog-control';
import {
  applyCatalogSourceStats,
  replayCachedCatalogStats,
  finalizeCatalogSourceBaseline,
} from './catalog-source-stats';

const WEEK_MS = 7 * 24 * 60 * 60_000;
export const KILTER_INCREMENTAL_TIMEOUT_MS = 10 * 60_000;
export const KILTER_FULL_TIMEOUT_MS = 2 * 60 * 60_000;
const WRITE_BATCH = 500;
type RefreshScope = CatalogScope & { layout: KilterRefProductLayout };

/** Scope identity includes the edge filter. Mapping changes invalidate every baseline. */
export function buildCatalogScopes(
  layouts: Array<KilterRefProductLayout & { layoutId: number }>,
  placementVersion: unknown = [],
): RefreshScope[] {
  const ordered = [...layouts].sort((left, right) => left.productLayoutUuid.localeCompare(right.productLayoutUuid));
  const mappingVersion = catalogMappingVersion({ version: 1, layouts: ordered, placements: placementVersion });
  const scopes = new Map<string, RefreshScope>();
  for (const layout of ordered) {
    const scopeKey = catalogMappingVersion([
      layout.productName,
      layout.edgeLeft,
      layout.edgeRight,
      layout.edgeBottom,
      layout.edgeTop,
    ]);
    if (!scopes.has(scopeKey)) scopes.set(scopeKey, { scopeKey, mappingVersion, layout });
  }
  return [...scopes.values()];
}

export function catalogRefreshMode(
  requested: 'auto' | 'incremental' | 'full',
  checkpoints: Array<{ baselineCompletedAt: Date | null; confirmedThrough: Date | null } | null>,
  now = Date.now(),
): 'full' | 'incremental' {
  const complete =
    checkpoints.length > 0 &&
    checkpoints.every((checkpoint) => checkpoint?.baselineCompletedAt && checkpoint.confirmedThrough);
  if (requested === 'incremental' && !complete)
    throw new Error('Kilter incremental sync requires a verified complete baseline for every scope');
  if (requested !== 'auto') return requested;
  return !complete || checkpoints.some((checkpoint) => now - checkpoint!.baselineCompletedAt!.getTime() >= WEEK_MS)
    ? 'full'
    : 'incremental';
}

function mergeSummary(target: KilterCatalogSummary, next: KilterCatalogSummary): void {
  for (const key of [
    'climbsSeen',
    'climbsUnmapped',
    'canonicalsInserted',
    'aliasesUpserted',
    'statsUpserted',
    'statsWritten',
    'selfAliasesBackfilled',
    'canonicalsRelisted',
    'relistsBlockedByDeletionHistory',
    'climbsRerouted',
    'skipsRecorded',
    'skipsResolved',
  ] as const) {
    target[key] += next[key];
  }
  target.skipsWriteFailed ||= next.skipsWriteFailed;
}

/** All catalog writers, including CLI full imports, share this database-clock lease. */
export async function refreshKilterCatalog(args: SyncKilterCatalogArgs): Promise<KilterCatalogSummary> {
  return withCatalogWriterLease(args, async ({ write: leasedWrite, signal: leaseSignal }) => {
    let executionSignal = AbortSignal.any([
      leaseSignal,
      AbortSignal.timeout(
        args.mode === 'incremental' || args.mode === 'auto' ? KILTER_INCREMENTAL_TIMEOUT_MS : KILTER_FULL_TIMEOUT_MS,
      ),
    ]);
    const write: CatalogWriteRunner = (work) =>
      leasedWrite(async (transaction) => {
        executionSignal.throwIfAborted();
        const result = await work(transaction);
        executionSignal.throwIfAborted();
        return result;
      });
    const runStartedAt = Date.now();
    const runKey = args.runKey ?? randomUUID();
    const log = args.log ?? (() => {});
    let token = await args.tokenProvider();
    const request = async <Result>(call: (accessToken: string) => Promise<Result>): Promise<Result> => {
      executionSignal.throwIfAborted();
      try {
        return await call(token);
      } catch (error) {
        if (!(error instanceof KilterApiError) || error.code !== 'unauthorized') throw error;
        token = await args.tokenProvider();
        return call(token);
      }
    };
    const reference =
      args.reference ??
      (await request((accessToken) => pullKilterReference({ accessToken, signal: executionSignal, log })));
    const resolver = await buildLayoutResolver(args.db);
    const mapped = reference.productLayouts
      .filter((layout) => layout.isListed)
      .flatMap((layout) => {
        const layoutId = resolver.resolve(layout.productLayoutUuid, layout.productName);
        return layoutId === null ? [] : [{ ...layout, layoutId }];
      });
    if (mapped.length === 0) throw new Error('No supported Kilter catalog scopes; baseline cannot be certified');
    const placements = await args.db
      .select({ layoutId: boardPlacements.layoutId, id: boardPlacements.id, holeId: boardPlacements.holeId })
      .from(boardPlacements)
      .where(
        and(
          eq(boardPlacements.boardType, 'kilter'),
          inArray(boardPlacements.layoutId, [...new Set(mapped.map((layout) => layout.layoutId))]),
        ),
      )
      .orderBy(boardPlacements.layoutId, boardPlacements.id);
    const scopes = buildCatalogScopes(mapped, {
      placements,
      listedDefinitions: reference.productLayouts
        .filter((layout) => layout.isListed)
        .sort((left, right) => left.productLayoutUuid.localeCompare(right.productLayoutUuid)),
    });
    const holeToPlacementByLayout = new Map<number, Map<number, number>>();
    for (const placement of placements) {
      if (placement.layoutId === null || placement.holeId === null) continue;
      const holes = holeToPlacementByLayout.get(placement.layoutId) ?? new Map<number, number>();
      holes.set(placement.holeId, placement.id);
      holeToPlacementByLayout.set(placement.layoutId, holes);
    }
    const checkpoints = await Promise.all(scopes.map((scope) => readCatalogCheckpoint(args.db, scope)));
    executionSignal.throwIfAborted();
    const requestedMode = args.mode ?? 'full';
    // A filtered import must never establish or advance complete coverage.
    const partial = args.layoutUuids !== undefined;
    if (partial && requestedMode === 'incremental')
      throw new Error('Incremental catalog sync does not support partial layout imports');
    const mode = partial ? 'full' : catalogRefreshMode(requestedMode, checkpoints);
    const remainingMs =
      (mode === 'incremental' ? KILTER_INCREMENTAL_TIMEOUT_MS : KILTER_FULL_TIMEOUT_MS) - (Date.now() - runStartedAt);
    const signal = AbortSignal.any([
      leaseSignal,
      remainingMs > 0
        ? AbortSignal.timeout(remainingMs)
        : AbortSignal.abort(new DOMException('Catalog execution budget exhausted', 'TimeoutError')),
    ]);
    executionSignal = signal;
    signal.throwIfAborted();
    const confirmed = checkpoints.flatMap((checkpoint) =>
      checkpoint?.baselineCompletedAt && checkpoint.confirmedThrough ? [checkpoint.confirmedThrough.getTime()] : [],
    );
    const completeCoverage = !partial && confirmed.length === scopes.length;
    const confirmedAt = completeCoverage ? new Date(Math.min(...confirmed)).toISOString() : undefined;
    log(
      `[kilter-catalog] refresh ${JSON.stringify({ mode, scopes: scopes.length, checkpointAgeMs: confirmedAt ? Date.now() - Date.parse(confirmedAt) : null })}`,
    );
    const baselineStart = new Date();
    if (mode === 'full' && !partial) {
      for (const scope of scopes) await startCatalogBaseline(write, scope, baselineStart);
    }

    let fetchedRows = 0;
    let fetchMs = 0;
    let applyMs = 0;
    let deferredCount = 0;
    const accepted = new Set<string>();
    const blocked = new Set<string>();
    const changedSources = new Map<string, { stat: KilterCatalogStat; canonicalUuid: string }>();
    const pending = new Map<
      string,
      {
        climb: KilterCatalogClimb;
        stats: KilterCatalogStat[];
        raw?: unknown;
        rawRows?: unknown[];
        conflicts?: unknown[];
      }
    >();
    const rememberClimbs = (climbs: KilterCatalogClimb[]) => {
      for (const climb of climbs) {
        const lowerUuid = climb.climbUuid.toLowerCase();
        const prior = pending.get(lowerUuid);
        const conflicts = prior?.conflicts ?? [];
        if (prior && (prior.climb.climbConcat !== climb.climbConcat || prior.climb.frameCount !== climb.frameCount)) {
          blocked.add(lowerUuid);
          accepted.delete(lowerUuid);
          conflicts.push({ climb: prior.climb, stats: prior.stats, raw: prior.raw });
        }
        pending.set(lowerUuid, {
          climb,
          stats: prior?.stats ?? [],
          raw: prior?.raw,
          rawRows: prior?.rawRows,
          conflicts,
        });
      }
    };
    const rememberStats = (stats: KilterCatalogStat[]) => {
      for (const stat of stats) pending.get(stat.climbUuid.toLowerCase())?.stats.push(stat);
    };
    const applyStats = async (rows: Array<{ stat: KilterCatalogStat; canonicalUuid: string }>) => {
      let sent = 0;
      let written = 0;
      for (let offset = 0; offset < rows.length; offset += WRITE_BATCH) {
        signal.throwIfAborted();
        const batch = rows
          .slice(offset, offset + WRITE_BATCH)
          .filter((row) => !blocked.has(row.stat.climbUuid.toLowerCase()));
        const outcome = await write(async (transaction) => {
          if (batch.length === 0) return { sent: 0, written: 0 };
          const cached = await transaction
            .select({
              sourceUuid: kilterCatalogSourceStats.sourceUuid,
              angle: kilterCatalogSourceStats.angle,
              canonicalUuid: kilterCatalogSourceStats.canonicalUuid,
            })
            .from(kilterCatalogSourceStats)
            .where(
              inArray(
                kilterCatalogSourceStats.sourceUuid,
                batch.map((row) => row.stat.climbUuid.toLowerCase()),
              ),
            );
          const previousCanonical = new Map<string, Set<string>>();
          for (const row of cached) {
            const canonicals = previousCanonical.get(row.sourceUuid) ?? new Set<string>();
            canonicals.add(row.canonicalUuid);
            previousCanonical.set(row.sourceUuid, canonicals);
          }
          for (const row of batch) {
            const sourceUuid = row.stat.climbUuid.toLowerCase();
            const previous = previousCanonical.get(sourceUuid);
            if (previous !== undefined && (previous.size !== 1 || !previous.has(row.canonicalUuid))) {
              // A changed alias graph cannot silently move a cached source.
              // Keep its old safe contribution and defer the complete payload.
              blocked.add(sourceUuid);
              accepted.delete(sourceUuid);
              const payload = pending.get(sourceUuid);
              if (payload)
                (payload.conflicts ??= []).push({
                  cachedCanonicals: [...previous],
                  incomingCanonical: row.canonicalUuid,
                  angle: row.stat.angle,
                });
            }
          }
          return applyCatalogSourceStats(
            transaction,
            batch.filter((row) => !blocked.has(row.stat.climbUuid.toLowerCase())),
            {
              completeCoverage: false,
              ...(mode === 'full' && !partial ? { generation: baselineStart.toISOString() } : {}),
            },
          );
        });
        sent += outcome.sent;
        written += outcome.written;
        for (const row of batch) {
          if (blocked.has(row.stat.climbUuid.toLowerCase())) continue;
          accepted.add(row.stat.climbUuid.toLowerCase());
          changedSources.set(`${row.stat.climbUuid.toLowerCase()}|${row.stat.angle}`, row);
        }
      }
      return { sent, written };
    };
    const timedFetch = async <Result extends unknown[]>(work: () => Promise<Result>): Promise<Result> => {
      signal.throwIfAborted();
      const started = Date.now();
      const response = await work();
      fetchMs += Date.now() - started;
      fetchedRows += response.length;
      return response;
    };
    // Deferred rows are replayed even when Kilter no longer includes their
    // timestamp. A newer response replaces the saved source payload.
    const deferred = await args.db
      .select()
      .from(kilterCatalogDeferred)
      .where(sql`${kilterCatalogDeferred.reason} <> 'resolved'`);
    const existingDeferred = new Set(deferred.map((row) => row.sourceUuid));
    deferredCount = existingDeferred.size;
    const replayByLayout = new Map<
      string,
      Array<{
        climb: KilterCatalogClimb;
        stats: KilterCatalogStat[];
        raw?: unknown;
        rawRows?: unknown[];
        conflicts?: unknown[];
      }>
    >();
    for (const row of deferred) {
      const saved = row.payload as {
        climb?: KilterCatalogClimb;
        stats?: KilterCatalogStat[];
        raw?: unknown;
        rawRows?: unknown[];
        conflicts?: unknown[];
      };
      if (!saved.climb || !Array.isArray(saved.stats)) throw new Error('Malformed durable Kilter deferred payload');
      const list = replayByLayout.get(saved.climb.productLayoutUuid) ?? [];
      list.push({ ...saved, climb: saved.climb, stats: saved.stats });
      replayByLayout.set(saved.climb.productLayoutUuid, list);
    }
    const persistDeferred = async () => {
      const unresolved = [...pending.entries()].filter(([sourceUuid]) => !accepted.has(sourceUuid));
      const resolved = [...accepted].filter((sourceUuid) => existingDeferred.has(sourceUuid));
      for (let offset = 0; offset < unresolved.length; offset += WRITE_BATCH) {
        signal.throwIfAborted();
        await write((transaction) =>
          transaction
            .insert(kilterCatalogDeferred)
            .values(
              unresolved.slice(offset, offset + WRITE_BATCH).map(([sourceUuid, record]) => ({
                sourceUuid,
                payload: record,
                reason: 'unresolved_geometry_or_alias',
              })),
            )
            .onConflictDoUpdate({
              target: kilterCatalogDeferred.sourceUuid,
              set: { payload: sql`excluded.payload`, reason: sql`excluded.reason`, updatedAt: sql`clock_timestamp()` },
            }),
        );
      }
      for (let offset = 0; offset < resolved.length; offset += WRITE_BATCH) {
        signal.throwIfAborted();
        await write((transaction) =>
          transaction
            .update(kilterCatalogDeferred)
            .set({ reason: 'resolved', updatedAt: sql`clock_timestamp()` })
            .where(inArray(kilterCatalogDeferred.sourceUuid, resolved.slice(offset, offset + WRITE_BATCH))),
        );
      }
      for (const [sourceUuid] of unresolved) existingDeferred.add(sourceUuid);
      for (const sourceUuid of resolved) existingDeferred.delete(sourceUuid);
      deferredCount = existingDeferred.size;
    };
    // Load identities across layouts, so a stale alias never moves source
    // statistics onto a canonical belonging to another board geometry.
    const identities = await args.db
      .select({ uuid: boardClimbs.uuid, layoutId: boardClimbs.layoutId })
      .from(boardClimbs)
      .where(eq(boardClimbs.boardType, 'kilter'));
    const aliases = await args.db
      .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
      .from(boardClimbAliases)
      .where(eq(boardClimbAliases.boardType, 'kilter'));
    const layoutByCanonical = new Map(identities.map((identity) => [identity.uuid, identity.layoutId]));
    const layoutsBySource = new Map<string, Set<number | null>>();
    for (const identity of identities) layoutsBySource.set(identity.uuid.toLowerCase(), new Set([identity.layoutId]));
    for (const alias of aliases) {
      const layouts = layoutsBySource.get(alias.aliasUuid.toLowerCase()) ?? new Set<number | null>();
      layouts.add(layoutByCanonical.get(alias.canonicalUuid) ?? null);
      layoutsBySource.set(alias.aliasUuid.toLowerCase(), layouts);
    }
    const safeClimbs = (climbs: KilterCatalogClimb[], layoutUuid: string) => {
      const target = mapped.find((layout) => layout.productLayoutUuid === layoutUuid)?.layoutId;
      return climbs.filter((climb) => {
        const existing = layoutsBySource.get(climb.climbUuid.toLowerCase());
        if (blocked.has(climb.climbUuid.toLowerCase())) return false;
        if (!existing) {
          layoutsBySource.set(climb.climbUuid.toLowerCase(), new Set([target ?? null]));
          return true;
        }
        if (existing.size === 1 && existing.has(target ?? null)) return true;
        const reject = () => {
          blocked.add(climb.climbUuid.toLowerCase());
          accepted.delete(climb.climbUuid.toLowerCase());
          return false;
        };
        if (existing.size !== 1 || target === undefined) return reject();
        const sourceHoles = holeToPlacementByLayout.get(target);
        if (!sourceHoles || decodeGripsClimbConcat(climb.climbConcat, sourceHoles, climb.frameCount).ok)
          return reject();
        const rerouted = findUniqueDecodableLayout(
          climb.climbConcat,
          climb.frameCount,
          target,
          holeToPlacementByLayout,
        );
        return rerouted !== null && existing.has(rerouted.layoutId) ? true : reject();
      });
    };
    const engine = async (
      climbs: (layoutUuid: string) => Promise<KilterCatalogClimb[]>,
      stats: (layoutUuid: string) => Promise<KilterCatalogStat[]>,
    ) => {
      const engineStartedAt = Date.now();
      const fetchBefore = fetchMs;
      const result = await syncFullKilterCatalog({
        ...args,
        runKey,
        reference,
        signal,
        transaction: write,
        catalogIO: {
          climbs: async (layoutUuid) => {
            const fetched = await climbs(layoutUuid);
            rememberClimbs(fetched);
            return safeClimbs(fetched, layoutUuid);
          },
          stats: async (layoutUuid) => {
            const fetched = await stats(layoutUuid);
            rememberStats(fetched);
            return fetched;
          },
          applyStats,
          acceptedClimbs: (sourceUuids) => {
            for (const sourceUuid of sourceUuids) if (!blocked.has(sourceUuid)) accepted.add(sourceUuid);
          },
          rejectedClimbs: (sourceUuids) => {
            for (const sourceUuid of sourceUuids) {
              blocked.add(sourceUuid);
              accepted.delete(sourceUuid);
            }
          },
        },
      });
      applyMs += Date.now() - engineStartedAt - (fetchMs - fetchBefore);
      return result;
    };

    let summary: KilterCatalogSummary | undefined;
    if (mode === 'full') {
      summary = await engine(
        (layoutUuid) => timedFetch(() => request((accessToken) => fetchLayoutClimbs(accessToken, layoutUuid, signal))),
        (layoutUuid) =>
          timedFetch(() => request((accessToken) => fetchLayoutClimbStats(accessToken, layoutUuid, signal))),
      );
      if (summary.skipsWriteFailed) throw new Error('Kilter baseline backlog did not persist');
      await persistDeferred();
    }
    if (!partial) {
      accepted.clear();
      pending.clear();
      blocked.clear();
      const deltaStarts: Date[] = [];
      const deltas = new Map<string, KilterCatalogDeltaRecord[]>();
      for (let index = 0; index < scopes.length; index += 1) {
        const scope = scopes[index];
        const requestStartedAt = new Date();
        deltaStarts.push(requestStartedAt);
        const since = mode === 'full' ? baselineStart : checkpoints[index]!.confirmedThrough!;
        const records = await timedFetch(() =>
          request((accessToken) =>
            fetchCatalogDelta(
              accessToken,
              {
                productName: scope.layout.productName,
                edgeLeft: scope.layout.edgeLeft,
                edgeRight: scope.layout.edgeRight,
                edgeTop: scope.layout.edgeTop,
                edgeBottom: scope.layout.edgeBottom,
                limit: 1000,
                offset: 0,
                excludeProductLayoutUuid: null,
                prioritizedProductLayoutUuid: scope.layout.productLayoutUuid,
                lastUpdatedAt: catalogDeltaSince(since).toISOString(),
              },
              signal,
            ),
          ),
        );
        for (const record of records) {
          rememberClimbs([record.climb]);
          const savedPayload = pending.get(record.climb.climbUuid.toLowerCase())!;
          savedPayload.raw = record.raw;
          (savedPayload.rawRows ??= []).push(record.raw);
          const layoutUuid = record.climb.productLayoutUuid;
          if (!mapped.some((layout) => layout.productLayoutUuid === layoutUuid)) {
            // Preserve an unknown layout verbatim; a future scope mapping can replay it.
            rememberClimbs([record.climb]);
            if (record.stat) rememberStats([record.stat]);
            pending.get(record.climb.climbUuid.toLowerCase())!.raw = record.raw;
            continue;
          }
          const list = deltas.get(layoutUuid) ?? [];
          list.push(record);
          deltas.set(layoutUuid, list);
        }
      }
      for (const [layoutUuid, saved] of replayByLayout) {
        if (!deltas.has(layoutUuid)) deltas.set(layoutUuid, []);
        const records = deltas.get(layoutUuid)!;
        const fetchedUuids = new Set(records.map((record) => record.climb.climbUuid.toLowerCase()));
        for (const record of saved) {
          if (fetchedUuids.has(record.climb.climbUuid.toLowerCase())) continue;
          pending.set(record.climb.climbUuid.toLowerCase(), {
            ...record,
            stats: mapped.some((layout) => layout.productLayoutUuid === layoutUuid) ? [] : record.stats,
          });
          if (record.stats.length === 0) records.push({ climb: record.climb, stat: null, raw: record.climb });
          for (const stat of record.stats) records.push({ climb: record.climb, stat, raw: record.climb });
        }
      }
      const deltaSummary = await engine(
        async (layoutUuid) => {
          const records = deltas.get(layoutUuid) ?? [];
          const climbsByUuid = new Map(records.map((record) => [record.climb.climbUuid.toLowerCase(), record.climb]));
          return [...climbsByUuid.values()];
        },
        async (layoutUuid) => (deltas.get(layoutUuid) ?? []).flatMap((record) => (record.stat ? [record.stat] : [])),
      );
      if (deltaSummary.skipsWriteFailed) throw new Error('Kilter delta backlog did not persist');
      if (summary) mergeSummary(summary, deltaSummary);
      else summary = deltaSummary;
      await persistDeferred();
      signal.throwIfAborted();
      const minimumWatermark = new Date(Math.min(...deltaStarts.map((started) => started.getTime()))).toISOString();
      const reconciliationStartedAt = Date.now();
      if (mode === 'full') {
        await finalizeCatalogSourceBaseline(args.db, write, baselineStart.toISOString());
      }
      if (mode === 'incremental') {
        const changed = [...changedSources.values()].filter((row) => !blocked.has(row.stat.climbUuid.toLowerCase()));
        for (let offset = 0; offset < changed.length; offset += WRITE_BATCH) {
          const outcome = await write((transaction) =>
            applyCatalogSourceStats(transaction, changed.slice(offset, offset + WRITE_BATCH), {
              completeCoverage: true,
              confirmedAt: minimumWatermark,
            }),
          );
          summary.statsUpserted += outcome.sent;
          summary.statsWritten += outcome.written;
        }
      }
      // The minimum confirmed request start can restamp unchanged daily stats,
      // only after every contributing scope and deferred record is durable.
      const replayOutcome = await replayCachedCatalogStats(args.db, write, {
        completeCoverage: true,
        confirmedAt: minimumWatermark,
        freshnessOnly: mode === 'incremental',
      });
      summary.statsUpserted += replayOutcome.sent;
      summary.statsWritten += replayOutcome.written;
      applyMs += Date.now() - reconciliationStartedAt;
      signal.throwIfAborted();
      // Checkpoint publication is the FINAL write, after all aggregate repairs.
      await write(async (transaction) => {
        const sameTransaction = async <Result>(work: (database: typeof transaction) => Promise<Result>) =>
          work(transaction);
        for (let index = 0; index < scopes.length; index += 1) {
          await completeCatalogCheckpoint(sameTransaction, scopes[index], deltaStarts[index], {
            baseline: mode === 'full',
          });
        }
      });
    }
    if (!summary) throw new Error('Kilter catalog refresh did not run');
    const metrics = {
      mode,
      fetchMs,
      applyMs,
      responseRows: fetchedRows,
      changedRows: summary.statsWritten,
      checkpointAgeMs: confirmedAt ? Date.now() - Date.parse(confirmedAt) : null,
      deferredRecords: deferredCount,
      executionMs: Date.now() - runStartedAt,
    };
    log(`[kilter-catalog] refresh done ${JSON.stringify(metrics)}`);
    args.onTelemetry?.(metrics);
    return summary;
  });
}
