import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';

// Any drizzle-orm PgDatabase (the backend's `db` singleton, or the
// `tx` a `db.transaction(...)` callback receives) satisfies this — the
// callers here always pass a transaction so the deletes are atomic with
// whatever else the caller is doing (e.g. deleting the climb row itself).
type DrizzleTx = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Delete the rows that hang off a set of climbs without an FK back to
 * `board_climbs` — `board_climb_stats`, `board_climb_stats_history`, and
 * `board_beta_links`. There is no `ON DELETE CASCADE` here on purpose:
 * stats legitimately arrive before their climb during upstream sync (see
 * the schema note at `packages/db/src/schema/boards/unified.ts` near the
 * `boardClimbStats` table), so every site that deletes a `board_climbs`
 * row is responsible for clearing these itself or it strands an orphan
 * (issue #3943).
 *
 * Callers MUST run this before deleting the `board_climbs` row(s) it
 * targets, in the same transaction. `board_climb_holds` needs no such
 * call — it has a real FK cascade (`board_climb_holds_climb_fk`).
 */
export async function deleteClimbDependentRows(
  tx: DrizzleTx,
  boardType: string,
  climbUuids: readonly string[],
): Promise<void> {
  if (climbUuids.length === 0) return;

  await tx
    .delete(dbSchema.boardClimbStats)
    .where(
      and(eq(dbSchema.boardClimbStats.boardType, boardType), inArray(dbSchema.boardClimbStats.climbUuid, climbUuids)),
    );

  await tx
    .delete(dbSchema.boardClimbStatsHistory)
    .where(
      and(
        eq(dbSchema.boardClimbStatsHistory.boardType, boardType),
        inArray(dbSchema.boardClimbStatsHistory.climbUuid, climbUuids),
      ),
    );

  await tx
    .delete(dbSchema.boardBetaLinks)
    .where(
      and(eq(dbSchema.boardBetaLinks.boardType, boardType), inArray(dbSchema.boardBetaLinks.climbUuid, climbUuids)),
    );
}

/**
 * Group (boardType, climbUuid) pairs by boardType, for callers that need
 * to clean up dependent rows for climbs spanning more than one board
 * (e.g. account deletion, where a user's drafts can live on any board).
 */
export function groupClimbUuidsByBoardType(
  climbs: readonly { boardType: string; uuid: string }[],
): Map<string, string[]> {
  const byBoardType = new Map<string, string[]>();
  for (const climb of climbs) {
    const existing = byBoardType.get(climb.boardType);
    if (existing) {
      existing.push(climb.uuid);
    } else {
      byBoardType.set(climb.boardType, [climb.uuid]);
    }
  }
  return byBoardType;
}
