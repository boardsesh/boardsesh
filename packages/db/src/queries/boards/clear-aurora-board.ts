import { and, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
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
//   - board_climbs with user_id IS NOT NULL       — user-created climbs (incl. drafts)
//   - board_climb_holds / _stats / _stats_history — belonging to those owned climbs
//   - board_beta_links with created_by_user_id     — links a Boardsesh user attached
//     IS NOT NULL                                    (to ANY climb on the board)
//
// The catalog metadata tables (products, sets, holes, placements, layouts, users,
// walls, circuits, tags, syncs, …) carry no Boardsesh-text-user rows — circuits /
// tags / walls key on the integer Aurora user id sourced from the dump — so they
// stay a full board-wide clear. See issue #3540.

type Tx = PgDatabase<PgQueryResultHKT>;

export type BoardseshOwnedCounts = {
  /** board_climbs rows with user_id IS NOT NULL (user-created climbs). */
  ownedClimbs: number;
  /** board_beta_links rows with created_by_user_id IS NOT NULL (Boardsesh-attached). */
  boardseshBetaLinks: number;
};

/**
 * Count the Boardsesh-owned rows a board refresh must preserve. Used both for the
 * operator-facing preflight log and for the in-transaction invariant assertion in
 * {@link clearAuroraBoardData}.
 */
export async function countBoardseshOwnedRows(tx: Tx, boardName: string): Promise<BoardseshOwnedCounts> {
  const [ownedClimbsRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, boardName), isNotNull(boardClimbs.userId)));

  const [betaLinksRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boardBetaLinks)
    .where(and(eq(boardBetaLinks.boardType, boardName), isNotNull(boardBetaLinks.createdByUserId)));

  return {
    ownedClimbs: ownedClimbsRow?.count ?? 0,
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
 * them after; a drop means the scoping regressed, so it throws to roll the whole
 * import transaction back. Run inside the import transaction — the throw aborts it.
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
  // (user_id IS NOT NULL below), so this anti-join set is stable no matter the
  // delete ordering. `uuid` is board_climbs' non-nullable primary key, so the
  // `NOT IN (subquery)` three-valued-logic footgun cannot occur — reusing one
  // named subquery across the three climb-dependent deletes reads more clearly
  // and stays DRY versus three separate correlated NOT EXISTS subqueries.
  const ownedClimbUuids = tx
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, boardName), isNotNull(boardClimbs.userId)));

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

  // Upstream climbs only — user-created climbs (user_id IS NOT NULL) survive.
  await tx.delete(boardClimbs).where(and(eq(boardClimbs.boardType, boardName), isNull(boardClimbs.userId)));

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
  // Boardsesh-owned row. A mismatch means the scoping regressed — abort the
  // import transaction rather than commit an unrecoverable deletion.
  const after = await countBoardseshOwnedRows(tx, boardName);
  if (after.ownedClimbs !== preserved.ownedClimbs || after.boardseshBetaLinks !== preserved.boardseshBetaLinks) {
    throw new Error(
      `clearAuroraBoardData refused to commit: Boardsesh-owned rows for "${boardName}" changed during clear ` +
        `(owned climbs ${preserved.ownedClimbs} -> ${after.ownedClimbs}, ` +
        `boardsesh beta links ${preserved.boardseshBetaLinks} -> ${after.boardseshBetaLinks}). ` +
        `The clear scoping is wrong; rolling back.`,
    );
  }

  return preserved;
}
