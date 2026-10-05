import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import {
  markClimbStatsRecomputePending,
  recomputeClimbStatsBulk,
  setSerialPlan,
  type ClimbStatsKey,
} from '@boardsesh/db/queries';
import type { BoardName } from '@boardsesh/board-constants';
import { queueClimbStatsRecompute } from '../ticks/debounced-climb-stats-publisher';

type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Restarting a climb's stats when an edit moves its holds (#6023), in three
 * steps that `updateClimb` runs in this order:
 *
 *  1. {@link markStatsKeysForHoldsChange}, before the edit writes anything;
 *  2. {@link recomputeStatsAfterHoldsChange}, once `recordClimbRevision` has
 *     moved `board_climbs.holds_revision_number`;
 *  3. {@link queueHoldsChangeStatsRefresh}, after the commit.
 */

/**
 * The stats keys a holds change will restart, each marked in
 * `climb_stats_recompute_pending` inside the edit's transaction.
 *
 * The keys are the angles of the climb that have a flash or a send, which are
 * the only rows a send ever fed:
 *
 *  - a climb nobody has sent has nothing to restart, and
 *  - a recompute writes the grade of an owned climb outside spray from its
 *    sends, so on a key with no send it would replace a setter's seeded grade
 *    with NULL. (On a key that has sends the grade is unchanged: the grade
 *    average reads every send, old holds included.)
 *
 * The angles come from the ticks, not from the climb's current angle, so a stats
 * row left behind by an earlier angle edit is restarted too.
 *
 * The marker does two jobs.
 *
 * It is a lock. Every batched recompute (the hourly self-heal, a sync's deferred
 * flush, the pending drain) takes the same marker rows, in the same
 * `(board_type, climb_uuid, angle)` order, before it reads a tick. So a batch
 * for one of these keys either finishes before this edit continues, or waits
 * for the edit to commit and then reads the new epoch. That is also why this
 * runs BEFORE `updateClimb` touches a stats row: markers first, stats rows
 * second, for both sides, or the two could wait on each other.
 *
 * It is a promise. The row commits with the edit and nothing here deletes it,
 * so the next self-heal pass recomputes these keys once more
 * (`drainPendingClimbStatsRecomputes`). That corrects the writers that do not
 * take markers: a `saveTick` recompute, or a sync that recomputes inside its
 * own write transaction, whose statement read the old epoch and wrote its count
 * after this edit committed. Without the marker only an in-process timer stood
 * behind that, and a deploy drops those.
 *
 * Called when the request MAY move the holds, which is decided before the
 * revision diff is. A save that turns out not to move them leaves markers
 * behind, and the drain's recompute of an unchanged key writes nothing.
 */
export async function markStatsKeysForHoldsChange(
  executor: DrizzleExecutor,
  boardType: BoardName,
  climbUuid: string,
): Promise<ClimbStatsKey[]> {
  const sentAngles = await executor
    .selectDistinct({ angle: dbSchema.boardseshTicks.angle })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        eq(dbSchema.boardseshTicks.boardType, boardType),
        eq(dbSchema.boardseshTicks.climbUuid, climbUuid),
        inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
      ),
    );
  const keys = sentAngles.map(({ angle }) => ({ boardType, climbUuid, angle }));
  await markClimbStatsRecomputePending(executor, keys);
  return keys;
}

/**
 * Recompute the marked keys now that the holds epoch has moved.
 *
 * The recompute reads the epoch (`tickOnCurrentHoldsSql`), so running it in the
 * transaction that moved it takes the ascensionist count to zero and clears the
 * first ascent and the stars together with the edit. No reader ever sees the
 * new holds with the old numbers.
 */
export async function recomputeStatsAfterHoldsChange(executor: DrizzleExecutor, keys: ClimbStatsKey[]): Promise<void> {
  if (keys.length === 0) return;
  // The same guard the single-key recompute sets: its aggregate joins ticks to
  // stats, the plan shape that exhausts shared memory when it goes parallel
  // (#4235). SET LOCAL, so it ends with the caller's transaction.
  await setSerialPlan(executor);
  await recomputeClimbStatsBulk(executor, keys);
}

/**
 * After the edit has committed: run the debounced recompute for the same keys.
 *
 * It publishes `climbStatsUpdated`, so an open climb list drops the old count,
 * and it usually corrects a racing `saveTick` within two seconds, long before
 * the self-heal gets to the marker.
 */
export function queueHoldsChangeStatsRefresh(keys: ClimbStatsKey[]): void {
  for (const key of keys) {
    queueClimbStatsRecompute(key.boardType, key.climbUuid, key.angle);
  }
}
