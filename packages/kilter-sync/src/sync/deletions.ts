import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbs, boardClimbAliases } from '@boardsesh/db/schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';

// Refuse to auto-apply a delete set larger than this — a malformed or
// empty-token /delteduuids response could otherwise wipe a big slice of the
// catalog. Above this, classify + report only and require a human.
const LARGE_DELETE_THRESHOLD = 2000;

export type DeletionReport = {
  reported: number;
  /** Pure-alias rows (alias_uuid ≠ canonical) safe to drop. */
  aliasDeletes: number;
  /** Lone self-canonicals (no other live alias) eligible for soft-delete. */
  softDeletes: number;
  /** Canonicals that still have live aliases — skipped (would orphan survivors). */
  skippedCanonicalWithAliases: number;
  /** UUIDs not found in board_* at all. */
  unknown: number;
  applied: boolean;
};

/**
 * Reconcile Kilter's server-side deletions (GET /climbs/delteduuids) against
 * board_*. Data deletion is gated: `applyDeletions` defaults off, in which case
 * we only classify and report what *would* happen. Even when on, we never hard
 * delete a canonical climb — pure aliases are removed, and a lone self-canonical
 * is soft-deleted (`is_listed = false`) so its holds/stats/history survive.
 * Canonicals that still back live aliases are left untouched.
 */
export async function reconcileDeletions(
  db: DrizzleDb,
  deletedUuids: string[],
  applyDeletions: boolean,
  log: (message: string) => void,
): Promise<DeletionReport> {
  const report: DeletionReport = {
    reported: deletedUuids.length,
    aliasDeletes: 0,
    softDeletes: 0,
    skippedCanonicalWithAliases: 0,
    unknown: 0,
    applied: false,
  };
  if (deletedUuids.length === 0) return report;

  // Kilter mixes uuid casing/formatting; the catalog stores climbs in whatever
  // casing Aurora used. Match case-insensitively.
  const lowered = deletedUuids.map((uuid) => uuid.toLowerCase());

  // Resolve each deleted uuid against the alias graph.
  const aliasRows = await db
    .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
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

  const aliasUuidsToDelete: string[] = [];
  const canonicalsToSoftDelete: string[] = [];
  const knownLower = new Set<string>();

  for (const alias of aliasRows) {
    knownLower.add(alias.aliasUuid.toLowerCase());
    const isSelfCanonical = alias.aliasUuid === alias.canonicalUuid;
    if (!isSelfCanonical) {
      // Pure alias → safe to drop the alias row; canonical + survivors stay.
      aliasUuidsToDelete.push(alias.aliasUuid);
      report.aliasDeletes += 1;
    } else if ((aliasCounts.get(alias.canonicalUuid) ?? 1) <= 1) {
      // Lone self-canonical → soft-delete only.
      canonicalsToSoftDelete.push(alias.canonicalUuid);
      report.softDeletes += 1;
    } else {
      // Canonical still has live aliases pointing at it — leave it.
      report.skippedCanonicalWithAliases += 1;
    }
  }
  report.unknown = lowered.filter((uuid) => !knownLower.has(uuid)).length;

  if (!applyDeletions) {
    log(
      `[kilter-catalog] deletions (report only): ${report.reported} reported → ${report.aliasDeletes} alias drops, ${report.softDeletes} soft-deletes, ${report.skippedCanonicalWithAliases} skipped (live aliases), ${report.unknown} unknown`,
    );
    return report;
  }

  const totalChanges = report.aliasDeletes + report.softDeletes;
  if (totalChanges > LARGE_DELETE_THRESHOLD) {
    log(
      `[kilter-catalog] REFUSING to apply ${totalChanges} deletions (> ${LARGE_DELETE_THRESHOLD}); rerun with manual review`,
    );
    return report;
  }

  if (aliasUuidsToDelete.length > 0) {
    await db
      .delete(boardClimbAliases)
      .where(and(eq(boardClimbAliases.boardType, KILTER), inArray(boardClimbAliases.aliasUuid, aliasUuidsToDelete)));
  }
  if (canonicalsToSoftDelete.length > 0) {
    await db
      .update(boardClimbs)
      .set({ isListed: false })
      .where(and(eq(boardClimbs.boardType, KILTER), inArray(boardClimbs.uuid, canonicalsToSoftDelete)));
  }
  report.applied = true;
  log(`[kilter-catalog] deletions applied: ${report.aliasDeletes} alias drops, ${report.softDeletes} soft-deletes`);
  return report;
}
