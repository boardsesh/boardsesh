import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbs, boardClimbAliases } from '@boardsesh/db/schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';

// Apply at most this many changes (alias drops + soft-deletes) per run. Kilter's
// /delteduuids is a full history of server-side deletions, so the first reconcile
// has a large backlog; draining it a batch at a time keeps any single cycle's
// blast radius small and lets the daemon work through it over successive runs.
export const DEFAULT_DELETE_BATCH_LIMIT = 500;

// Refuse to apply if the candidate backlog exceeds this fraction of the live,
// synced Kilter catalog. A malformed /delteduuids (empty token, mass upstream
// unpublish) shows up as a backlog spike; above this we report only and wait for
// a human rather than unlist a big slice of the catalog in one go.
export const ANOMALY_FRACTION = 0.25;

export type DeletionReport = {
  reported: number;
  /** Pure-alias rows (alias_uuid ≠ canonical), source='kilter', eligible to drop. */
  aliasDeletes: number;
  /** Lone synced (userId null) self-canonicals still listed — eligible to unlist. */
  softDeletes: number;
  /** Canonical is user-authored (userId set) — never touched by the catalog sync. */
  protectedUserAuthored: number;
  /** Pure alias whose source ≠ 'kilter' (backfill/aurora) — not ours to drop. */
  skippedForeignSource: number;
  /** Canonicals that still back live aliases — skipped (would orphan survivors). */
  skippedCanonicalWithAliases: number;
  /**
   * Rows already is_listed=false from a prior run (drained) — self-canonicals
   * from the alias graph plus direct-uuid matches outside it.
   */
  alreadyUnlisted: number;
  /**
   * Reported uuids absent from the alias graph but matched directly against a
   * live synced board_climbs.uuid — the self-alias-gap fallback (see below).
   * Soft-deleted like a lone self-canonical.
   */
  directUuidSoftDeletes: number;
  /** Reported uuids found in neither the alias graph nor board_climbs (expected). */
  unknown: number;
  applied: boolean;
  /** Changes actually written this cycle (alias drops + soft-deletes). */
  appliedThisRun: number;
  /** Candidates not applied this run — the backlog tail for the next cycle. */
  remaining: number;
  /** Anomaly guard tripped — backlog too large, nothing applied. */
  refused: boolean;
};

export type AliasClassificationRow = {
  aliasUuid: string;
  canonicalUuid: string;
  source: string;
  canonicalUserId: string | null;
  canonicalIsListed: boolean | null;
};

export type DeletionClassification = {
  aliasUuidsToDelete: string[];
  canonicalsToSoftDelete: string[];
  protectedUserAuthored: number;
  skippedForeignSource: number;
  skippedCanonicalWithAliases: number;
  alreadyUnlisted: number;
  /** Lowered reported uuids absent from the alias graph — fed to the direct fallback. */
  unknownLoweredUuids: string[];
  unknown: number;
};

/**
 * Pure classification of Kilter's reported deletions against the alias graph.
 * The safety rules live here so they're unit-testable without a database:
 *
 *  - A pure alias (alias ≠ canonical) is dropped ONLY when its `source` is
 *    'kilter' — i.e. the catalog sync created it. 'backfill'/'aurora' alias rows
 *    are never dropped by this pass.
 *  - A self-canonical is soft-deleted ONLY when the underlying climb is
 *    Kilter-synced (`userId` is null), still listed, and no other live alias
 *    backs it. A climb with a `userId` is user-authored and is always protected.
 */
export function classifyKilterDeletions(input: {
  loweredUuids: string[];
  aliasRows: AliasClassificationRow[];
  aliasCounts: Map<string, number>;
}): DeletionClassification {
  const { loweredUuids, aliasRows, aliasCounts } = input;
  const aliasUuidsToDelete: string[] = [];
  const canonicalsToSoftDelete: string[] = [];
  const knownLower = new Set<string>();
  let protectedUserAuthored = 0;
  let skippedForeignSource = 0;
  let skippedCanonicalWithAliases = 0;
  let alreadyUnlisted = 0;

  for (const row of aliasRows) {
    knownLower.add(row.aliasUuid.toLowerCase());
    // Case-insensitive: the lookup matches on lower(alias_uuid), and a self-alias
    // is the same climb regardless of casing — comparing raw could misclassify a
    // case-variant self-canonical as a pure alias.
    const isSelfCanonical = row.aliasUuid.toLowerCase() === row.canonicalUuid.toLowerCase();

    if (!isSelfCanonical) {
      // Pure alias → drop the alias row only if the catalog sync created it.
      if (row.source === KILTER) {
        aliasUuidsToDelete.push(row.aliasUuid);
      } else {
        skippedForeignSource += 1;
      }
      continue;
    }

    // Self-canonical → decide whether to unlist the underlying climb.
    if (row.canonicalUserId != null) {
      // User-authored climb. Off-limits to the catalog sync, full stop.
      protectedUserAuthored += 1;
      continue;
    }
    if (row.canonicalIsListed === false) {
      // Already unlisted on a prior run — drained, nothing to do.
      alreadyUnlisted += 1;
      continue;
    }
    if ((aliasCounts.get(row.canonicalUuid) ?? 1) <= 1) {
      canonicalsToSoftDelete.push(row.canonicalUuid);
    } else {
      // Still backs live aliases — soft-deleting now would orphan them. Once the
      // alias rows drain on later runs it becomes lone and is picked up.
      skippedCanonicalWithAliases += 1;
    }
  }

  // Uuids the alias graph never knew about. Before the self-alias backfill,
  // ~6k synced kilter climbs reached the catalog without a self-alias, so a
  // genuine upstream deletion of one landed here and was silently ignored. The
  // caller resolves these against board_climbs.uuid directly (see below).
  const unknownLoweredUuids = loweredUuids.filter((uuid) => !knownLower.has(uuid));
  return {
    aliasUuidsToDelete,
    canonicalsToSoftDelete,
    protectedUserAuthored,
    skippedForeignSource,
    skippedCanonicalWithAliases,
    alreadyUnlisted,
    unknownLoweredUuids,
    unknown: unknownLoweredUuids.length,
  };
}

/**
 * Slice the classified candidates down to a single run's batch. Deterministic
 * (sorted) so successive runs cover fresh candidates; alias drops go first
 * because they permanently shrink the backlog.
 */
export function planDeletionBatch(
  classification: Pick<DeletionClassification, 'aliasUuidsToDelete' | 'canonicalsToSoftDelete'>,
  batchLimit: number,
): { aliasBatch: string[]; softBatch: string[]; appliedThisRun: number; remaining: number } {
  const aliasSorted = [...classification.aliasUuidsToDelete].sort();
  const softSorted = [...classification.canonicalsToSoftDelete].sort();
  const backlog = aliasSorted.length + softSorted.length;
  const limit = Math.max(0, batchLimit);
  const aliasBatch = aliasSorted.slice(0, limit);
  const softBatch = softSorted.slice(0, Math.max(0, limit - aliasBatch.length));
  const appliedThisRun = aliasBatch.length + softBatch.length;
  return { aliasBatch, softBatch, appliedThisRun, remaining: backlog - appliedThisRun };
}

/**
 * Wipe-signal check: would this run unlist an implausibly large slice of the live
 * catalog? Keyed on the SOFT-DELETE count — the action that actually removes
 * climbs from view — not alias-drops, which are safe duplicate-row cleanup that
 * leave every canonical listed. A benign backlog of pure alias drops therefore
 * can't trip the guard.
 */
export function isAnomalousDeletionBacklog(softDeleteCount: number, liveListedCount: number): boolean {
  if (liveListedCount <= 0) return false;
  return softDeleteCount > liveListedCount * ANOMALY_FRACTION;
}

/**
 * Reconcile Kilter's server-side deletions (GET /climbs/delteduuids) against
 * board_*. Only ever touches climbs the Kilter catalog sync itself owns:
 *
 *  - user-authored climbs (board_climbs.user_id set) are never modified;
 *  - only 'kilter'-sourced pure-alias rows are hard-deleted (canonical survives);
 *  - a lone synced self-canonical is soft-deleted (`is_listed = false`), which is
 *    reversible and preserves its holds/stats/history.
 *
 * `applyDeletions` defaults off (classify + report only). When on, changes are
 * applied a `batchLimit`-sized batch per run and the backlog drains over
 * successive cycles; an anomaly guard refuses an implausibly large batch.
 */
export async function reconcileDeletions(
  db: DrizzleDb,
  deletedUuids: string[],
  applyDeletions: boolean,
  log: (message: string) => void,
  options?: {
    batchLimit?: number;
    /** Runs the one apply transaction (a background job's attempt fence). Defaults to `db.transaction`. */
    transaction?: <Result>(callback: (tx: DrizzleDb) => Promise<Result>) => Promise<Result>;
  },
): Promise<DeletionReport> {
  // A non-positive batch limit would silently stall the drain (0 changes/run,
  // never erroring); fall back to the default instead.
  const configuredLimit = options?.batchLimit;
  const batchLimit = configuredLimit != null && configuredLimit > 0 ? configuredLimit : DEFAULT_DELETE_BATCH_LIMIT;
  const report: DeletionReport = {
    reported: deletedUuids.length,
    aliasDeletes: 0,
    softDeletes: 0,
    protectedUserAuthored: 0,
    skippedForeignSource: 0,
    skippedCanonicalWithAliases: 0,
    alreadyUnlisted: 0,
    directUuidSoftDeletes: 0,
    unknown: 0,
    applied: false,
    appliedThisRun: 0,
    remaining: 0,
    refused: false,
  };
  if (deletedUuids.length === 0) return report;

  // Kilter mixes uuid casing/formatting; the catalog stores climbs in whatever
  // casing Aurora used. Match case-insensitively.
  const lowered = deletedUuids.map((uuid) => uuid.toLowerCase());

  // Resolve each deleted uuid against the alias graph, carrying the canonical
  // climb's provenance (userId) and listing state so the classifier can protect
  // user content and skip already-drained rows.
  const aliasRows: AliasClassificationRow[] = await db
    .select({
      aliasUuid: boardClimbAliases.aliasUuid,
      canonicalUuid: boardClimbAliases.canonicalUuid,
      source: boardClimbAliases.source,
      canonicalUserId: boardClimbs.userId,
      canonicalIsListed: boardClimbs.isListed,
    })
    .from(boardClimbAliases)
    .leftJoin(
      boardClimbs,
      and(eq(boardClimbs.uuid, boardClimbAliases.canonicalUuid), eq(boardClimbs.boardType, KILTER)),
    )
    .where(and(eq(boardClimbAliases.boardType, KILTER), inArray(sql`lower(${boardClimbAliases.aliasUuid})`, lowered)));

  // How many live aliases does each canonical still have? (to avoid orphaning)
  const canonicals = [...new Set(aliasRows.map((row) => row.canonicalUuid))];
  const aliasCounts = new Map<string, number>();
  if (canonicals.length > 0) {
    const counts = await db
      .select({ canonicalUuid: boardClimbAliases.canonicalUuid, count: sql<number>`count(*)::int` })
      .from(boardClimbAliases)
      .where(and(eq(boardClimbAliases.boardType, KILTER), inArray(boardClimbAliases.canonicalUuid, canonicals)))
      .groupBy(boardClimbAliases.canonicalUuid);
    for (const row of counts) aliasCounts.set(row.canonicalUuid, row.count);
  }

  const classification = classifyKilterDeletions({ loweredUuids: lowered, aliasRows, aliasCounts });
  report.aliasDeletes = classification.aliasUuidsToDelete.length;
  report.softDeletes = classification.canonicalsToSoftDelete.length;
  report.protectedUserAuthored = classification.protectedUserAuthored;
  report.skippedForeignSource = classification.skippedForeignSource;
  report.skippedCanonicalWithAliases = classification.skippedCanonicalWithAliases;
  report.alreadyUnlisted = classification.alreadyUnlisted;

  // Direct-uuid fallback: a reported deletion whose uuid the alias graph never
  // knew (the self-alias gap) can still match a board_climbs row directly by
  // uuid (case-insensitive). Classify EVERY match into the alias-graph buckets —
  // not just the actionable ones — so a row drained on a prior run is reported
  // as alreadyUnlisted instead of being re-counted as "never-imported (unknown)"
  // on every subsequent cycle:
  //   - synced (user_id NULL), is_listed true OR NULL → soft-delete, exactly
  //     like a lone self-canonical. NULL is invisible in search but has never
  //     been written explicitly — Kilter reporting it deleted must still write
  //     is_listed = false so the 0144/0146 sync trigger fires and offline
  //     clients receive the removal (the reverse of the IS NOT TRUE re-list
  //     rule; the alias-graph classifier likewise only short-circuits on an
  //     explicit false);
  //   - synced + explicitly unlisted (false) → alreadyUnlisted (drained);
  //   - user-authored → protectedUserAuthored (never touched, mirrors the
  //     alias-graph protection).
  // Only uuids matched by NEITHER path remain unknown (truly never imported).
  const directSoftDeletes: string[] = [];
  let directResolved = 0;
  if (classification.unknownLoweredUuids.length > 0) {
    const directRows = await db
      .select({ uuid: boardClimbs.uuid, isListed: boardClimbs.isListed, userId: boardClimbs.userId })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.boardType, KILTER),
          inArray(sql`lower(${boardClimbs.uuid})`, classification.unknownLoweredUuids),
        ),
      );
    directResolved = directRows.length;
    for (const row of directRows) {
      if (row.userId != null) {
        report.protectedUserAuthored += 1;
      } else if (row.isListed !== false) {
        directSoftDeletes.push(row.uuid);
      } else {
        report.alreadyUnlisted += 1;
      }
    }
  }
  report.directUuidSoftDeletes = directSoftDeletes.length;
  // Only the rows matched by neither path are truly never-imported.
  report.unknown = classification.unknown - directResolved;

  // Both self-canonicals and direct-uuid matches are soft-deletes (is_listed →
  // false on board_climbs.uuid), so batch/guard/apply treat them as one set.
  const allSoftDeletes = [...classification.canonicalsToSoftDelete, ...directSoftDeletes];
  const totalSoftDeletes = allSoftDeletes.length;

  const backlog = report.aliasDeletes + totalSoftDeletes;

  if (!applyDeletions) {
    report.remaining = backlog;
    log(
      `[kilter-catalog] deletions (report only): ${report.reported} reported → ${report.aliasDeletes} alias drops, ${report.softDeletes} soft-deletes, ${report.directUuidSoftDeletes} direct-uuid soft-deletes, ${report.skippedCanonicalWithAliases} skipped (live aliases), ${report.protectedUserAuthored} protected (user-authored), ${report.alreadyUnlisted} already unlisted, ${report.unknown} never-imported (expected)`,
    );
    return report;
  }

  if (backlog === 0) {
    report.applied = true;
    log(
      `[kilter-catalog] deletions: nothing to apply (${report.reported} reported, ${report.protectedUserAuthored} protected, ${report.unknown} never-imported)`,
    );
    return report;
  }

  // Anomaly guard against a malformed /delteduuids or a mass upstream unpublish.
  // Only soft-deletes remove climbs from view, so gate on them — a backlog of pure
  // alias drops is safe duplicate-row cleanup and applies (batch-capped) unguarded.
  // NB: gate on the TOTAL soft-delete backlog, not the per-run batch — a genuine
  // mass-delete would otherwise drain a batch at a time and silently unlist a big
  // slice of the catalog without ever tripping. If a large drop is legitimate, the
  // operator reviews it and raises ANOMALY_FRACTION for a one-off manual apply.
  if (totalSoftDeletes > 0) {
    const [liveRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.boardType, KILTER), eq(boardClimbs.isListed, true), isNull(boardClimbs.userId)));
    const liveListedCount = liveRow?.count ?? 0;
    if (isAnomalousDeletionBacklog(totalSoftDeletes, liveListedCount)) {
      report.refused = true;
      report.remaining = backlog;
      log(
        `[kilter-catalog] REFUSING deletions: ${totalSoftDeletes} soft-deletes exceed ${Math.round(ANOMALY_FRACTION * 100)}% of ${liveListedCount} live climbs — manual review required`,
      );
      return report;
    }
  }

  const { aliasBatch, softBatch, appliedThisRun, remaining } = planDeletionBatch(
    { aliasUuidsToDelete: classification.aliasUuidsToDelete, canonicalsToSoftDelete: allSoftDeletes },
    batchLimit,
  );
  // Apply both writes atomically so a crash can't leave the batch half-applied.
  const runApply = options?.transaction ?? ((callback) => db.transaction(callback));
  await runApply(async (tx) => {
    if (aliasBatch.length > 0) {
      // source='kilter' + board_type guards belt-and-suspenders the classifier.
      await tx
        .delete(boardClimbAliases)
        .where(
          and(
            eq(boardClimbAliases.boardType, KILTER),
            eq(boardClimbAliases.source, KILTER),
            inArray(boardClimbAliases.aliasUuid, aliasBatch),
          ),
        );
    }
    if (softBatch.length > 0) {
      // isNull(userId) guard ensures we never flip a user-authored climb, even if
      // classification and apply somehow raced against a concurrent write.
      await tx
        .update(boardClimbs)
        .set({ isListed: false })
        .where(
          and(eq(boardClimbs.boardType, KILTER), isNull(boardClimbs.userId), inArray(boardClimbs.uuid, softBatch)),
        );
    }
  });
  report.applied = true;
  report.appliedThisRun = appliedThisRun;
  report.remaining = remaining;
  log(
    `[kilter-catalog] deletions applied: ${aliasBatch.length} alias drops, ${softBatch.length} soft-deletes (${remaining} remaining, batch limit ${batchLimit})`,
  );
  return report;
}
