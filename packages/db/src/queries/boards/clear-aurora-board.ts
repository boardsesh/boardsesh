import { and, eq, inArray, isNull, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardAttempts,
  boardBetaLinks,
  boardCircuits,
  boardCircuitsClimbs,
  boardClimbHolds,
  boardClimbs,
  boardClimbStats,
  boardClimbStatsHistory,
  boardDifficultyGrades,
  boardHoles,
  boardLayouts,
  boardLeds,
  boardPlacements,
  boardPlacementRoles,
  boardProducts,
  boardProductSizes,
  boardProductSizesLayoutsSets,
  boardSets,
  boardSharedSyncs,
  boardTags,
  boardUserSyncs,
  boardUsers,
  boardWalls,
} from '../../schema/boards/unified';

// The unified Aurora importer (packages/db/scripts/import-aurora-board-unified.ts)
// refreshes a whole direct-Aurora board (decoy / touchstone / grasshopper / soill)
// by clearing the board's rows and re-inserting the catalog dump. The clear must
// replace the UPSTREAM catalog wholesale (so climbs removed from the dump vanish)
// WITHOUT touching Boardsesh-owned rows, which the dump can never restore:
//
//   - Boardsesh-provenance climbs (synced = false), including local drafts,
//     JSON-import placeholders and published climbs from deleted accounts
//   - board_climb_holds / _stats / _stats_history belonging to those climbs
//   - board_beta_links with created_by_user_id IS NOT NULL
//     (links a Boardsesh user attached to any climb on the board)
//
// `synced` is the provenance marker: local save/publish and JSON-import writes
// use false; Aurora catalog and account-import inserts use true. A linked
// account can own an upstream draft, so user_id must not preserve that imported
// row after it disappears from an authoritative dump. Conversely, deleted
// accounts lose user_id while their local published climbs remain synced=false.
//
// The catalog metadata tables (products, sets, holes, placements, layouts, users,
// walls, circuits, tags, syncs, …) carry no Boardsesh-text-user rows — circuits /
// tags / walls key on the integer Aurora user id sourced from the dump — so they
// stay a full board-wide clear. See issue #3540.

type Tx = PgDatabase<PgQueryResultHKT>;

export type BoardseshOwnedCounts = {
  /** Boardsesh-provenance board_climbs (synced = false). */
  ownedClimbs: number;
  /** board_climb_holds belonging to those owned climbs. */
  ownedHolds: number;
  /** board_climb_stats belonging to those owned climbs. */
  ownedStats: number;
  /** board_climb_stats_history belonging to those owned climbs. */
  ownedStatsHistory: number;
  /** board_beta_links rows with created_by_user_id IS NOT NULL (Boardsesh-attached). */
  boardseshBetaLinks: number;
};

/**
 * The stable Boardsesh-provenance filter: synced=false, independent of owner.
 */
function boardseshOwnedClimbWhere(boardName: string) {
  return and(eq(boardClimbs.boardType, boardName), eq(boardClimbs.synced, false));
}

/**
 * Count the Boardsesh-owned rows a board refresh must preserve — climbs, their
 * holds/stats/history, and Boardsesh-attached beta links. Used both for the
 * operator-facing preflight log and for the in-transaction invariant assertion in
 * {@link clearAuroraBoardData} (which compares every count before vs. after).
 */
export async function countBoardseshOwnedRows(tx: Tx, boardName: string): Promise<BoardseshOwnedCounts> {
  // The owned-climb uuids the holds/stats/history counts anti-key on. Owned climbs
  // are never deleted by the clear, so this set is identical before and after.
  const ownedClimbUuids = tx
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(boardseshOwnedClimbWhere(boardName));

  const [ownedClimbsRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardClimbs)
    .where(boardseshOwnedClimbWhere(boardName));

  const [ownedHoldsRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardClimbHolds)
    .where(and(eq(boardClimbHolds.boardType, boardName), inArray(boardClimbHolds.climbUuid, ownedClimbUuids)));

  const [ownedStatsRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardClimbStats)
    .where(and(eq(boardClimbStats.boardType, boardName), inArray(boardClimbStats.climbUuid, ownedClimbUuids)));

  const [ownedStatsHistoryRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardClimbStatsHistory)
    .where(
      and(eq(boardClimbStatsHistory.boardType, boardName), inArray(boardClimbStatsHistory.climbUuid, ownedClimbUuids)),
    );

  const [betaLinksRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardBetaLinks)
    .where(and(eq(boardBetaLinks.boardType, boardName), isNotNull(boardBetaLinks.createdByUserId)));

  return {
    ownedClimbs: ownedClimbsRow?.count ?? 0,
    ownedHolds: ownedHoldsRow?.count ?? 0,
    ownedStats: ownedStatsRow?.count ?? 0,
    ownedStatsHistory: ownedStatsHistoryRow?.count ?? 0,
    boardseshBetaLinks: betaLinksRow?.count ?? 0,
  };
}

/**
 * Provenance-aware clear for a direct-Aurora board refresh (issue #3540).
 *
 * Deletes every UPSTREAM row for {@link boardName} so the re-inserted catalog dump
 * fully replaces it, while preserving Boardsesh-owned climbs, their holds/stats/
 * history, and Boardsesh-attached beta links (which the dump cannot restore).
 *
 * Primary guardrail: snapshots the owned-row counts before the clear and re-checks
 * every one after; a drop means the scoping regressed, so it throws to roll the
 * whole import transaction back. Run inside the import transaction — the throw
 * aborts it.
 *
 * Returns the preserved-row counts (for the caller's preflight/summary log).
 */
export async function clearAuroraBoardData(tx: Tx, boardName: string): Promise<BoardseshOwnedCounts> {
  // The rows deleted here are recreated in this same transaction; tell the sync
  // tombstone triggers (log_deletion_board_climbs / _stats) to stand down, or the
  // re-import floods sync_deletions with one NULL-scoped row per climb and every
  // offline client deletes its just-repulled board copy. SET LOCAL scopes the GUC
  // to this transaction only.
  await tx.execute(sql`SET LOCAL boardsesh.suppress_sync_tombstones = 'on'`);

  const preserved = await countBoardseshOwnedRows(tx, boardName);

  // The Boardsesh-owned climb uuids to preserve. These rows are never deleted
  // (they fail the upstream `synced = true` predicate below),
  // so this anti-join set is stable no matter the delete ordering. `uuid` is
  // board_climbs' non-nullable primary key, so the `NOT IN (subquery)`
  // three-valued-logic footgun cannot occur — reusing one named subquery across
  // the three climb-dependent deletes reads more clearly and stays DRY versus
  // three separate correlated NOT EXISTS subqueries.
  const ownedClimbUuids = tx
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(boardseshOwnedClimbWhere(boardName));

  // Catalog-only tables (no Boardsesh-owned rows): full board-wide clear.
  await tx.delete(boardTags).where(eq(boardTags.boardType, boardName));
  await tx.delete(boardCircuitsClimbs).where(eq(boardCircuitsClimbs.boardType, boardName));

  // Boardsesh-attached beta links (created_by_user_id IS NOT NULL) are preserved
  // wherever they hang — a Boardsesh user can attach a link to an upstream climb.
  await tx
    .delete(boardBetaLinks)
    .where(and(eq(boardBetaLinks.boardType, boardName), isNull(boardBetaLinks.createdByUserId)));

  // Climb-dependent tables: clear only rows tied to upstream (non-owned) climbs,
  // so an owned climb keeps its holds (else it renders blank), its stats, and its
  // history. Owned climbs' stats are updated in place by the later tick recompute.
  await tx
    .delete(boardClimbStatsHistory)
    .where(
      and(
        eq(boardClimbStatsHistory.boardType, boardName),
        notInArray(boardClimbStatsHistory.climbUuid, ownedClimbUuids),
      ),
    );
  await tx
    .delete(boardClimbHolds)
    .where(and(eq(boardClimbHolds.boardType, boardName), notInArray(boardClimbHolds.climbUuid, ownedClimbUuids)));
  await tx
    .delete(boardClimbStats)
    .where(and(eq(boardClimbStats.boardType, boardName), notInArray(boardClimbStats.climbUuid, ownedClimbUuids)));

  // Replace upstream climbs, including account-owned drafts. Local provenance
  // survives even after account deletion nulls its owner.
  await tx.delete(boardClimbs).where(and(eq(boardClimbs.boardType, boardName), eq(boardClimbs.synced, true)));

  // Remaining catalog metadata: full board-wide clear.
  await tx.delete(boardCircuits).where(eq(boardCircuits.boardType, boardName));
  await tx.delete(boardUserSyncs).where(eq(boardUserSyncs.boardType, boardName));
  await tx.delete(boardWalls).where(eq(boardWalls.boardType, boardName));
  await tx.delete(boardProductSizesLayoutsSets).where(eq(boardProductSizesLayoutsSets.boardType, boardName));
  await tx.delete(boardPlacements).where(eq(boardPlacements.boardType, boardName));
  await tx.delete(boardLeds).where(eq(boardLeds.boardType, boardName));
  await tx.delete(boardPlacementRoles).where(eq(boardPlacementRoles.boardType, boardName));
  await tx.delete(boardHoles).where(eq(boardHoles.boardType, boardName));
  await tx.delete(boardLayouts).where(eq(boardLayouts.boardType, boardName));
  await tx.delete(boardProductSizes).where(eq(boardProductSizes.boardType, boardName));
  await tx.delete(boardSets).where(eq(boardSets.boardType, boardName));
  await tx.delete(boardProducts).where(eq(boardProducts.boardType, boardName));
  await tx.delete(boardUsers).where(eq(boardUsers.boardType, boardName));
  await tx.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, boardName));
  await tx.delete(boardDifficultyGrades).where(eq(boardDifficultyGrades.boardType, boardName));
  await tx.delete(boardAttempts).where(eq(boardAttempts.boardType, boardName));

  // Primary guardrail: the scoped clear must not have removed a single
  // Boardsesh-owned row — climbs, their holds/stats/history, or attached beta
  // links. Any drop means the scoping regressed; abort the import transaction
  // rather than commit an unrecoverable deletion.
  const after = await countBoardseshOwnedRows(tx, boardName);
  const drifted =
    after.ownedClimbs !== preserved.ownedClimbs ||
    after.ownedHolds !== preserved.ownedHolds ||
    after.ownedStats !== preserved.ownedStats ||
    after.ownedStatsHistory !== preserved.ownedStatsHistory ||
    after.boardseshBetaLinks !== preserved.boardseshBetaLinks;
  if (drifted) {
    throw new Error(
      `clearAuroraBoardData refused to commit: Boardsesh-owned rows for "${boardName}" changed during clear ` +
        `(climbs ${preserved.ownedClimbs}->${after.ownedClimbs}, holds ${preserved.ownedHolds}->${after.ownedHolds}, ` +
        `stats ${preserved.ownedStats}->${after.ownedStats}, history ${preserved.ownedStatsHistory}->${after.ownedStatsHistory}, ` +
        `beta links ${preserved.boardseshBetaLinks}->${after.boardseshBetaLinks}). The clear scoping is wrong; rolling back.`,
    );
  }

  return preserved;
}
