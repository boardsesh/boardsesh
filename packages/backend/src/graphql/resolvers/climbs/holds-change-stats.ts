import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { recomputeClimbStatsBulk, setSerialPlan, type ClimbStatsKey } from '@boardsesh/db/queries';
import type { BoardName } from '@boardsesh/board-constants';
import { queueClimbStatsRecompute } from '../ticks/debounced-climb-stats-publisher';

type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Restart a climb's stats after an edit moved its holds (#6023).
 *
 * `recordClimbRevision` has just moved `board_climbs.holds_revision_number`, so
 * every send logged so far is now on an older version of the climb. The
 * recompute reads that epoch (`tickOnCurrentHoldsSql`), so running it here, in
 * the transaction that moved the epoch, takes the ascensionist count to zero and
 * clears the first ascent and the stars together with the edit. No reader ever
 * sees the new holds with the old numbers.
 *
 * Only the angles that have a flash or send are recomputed, which are the only
 * rows a send ever fed:
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
 * Returns the keys it recomputed, for {@link queueHoldsChangeStatsRefresh}.
 */
export async function recomputeStatsAfterHoldsChange(
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
  if (sentAngles.length === 0) return [];

  const keys = sentAngles.map(({ angle }) => ({ boardType, climbUuid, angle }));
  // The same guard the single-key recompute sets: its aggregate joins ticks to
  // stats, the plan shape that exhausts shared memory when it goes parallel
  // (#4235). SET LOCAL, so it ends with the caller's transaction.
  await setSerialPlan(executor);
  await recomputeClimbStatsBulk(executor, keys);
  return keys;
}

/**
 * After the edit has committed: run the debounced recompute for the same keys.
 *
 * It publishes `climbStatsUpdated`, so an open climb list drops the old count.
 * It also closes a race: a `saveTick` whose recompute read the old epoch and
 * wrote after this edit committed leaves the old numbers on the row, and this
 * pass, two seconds later, reads the committed epoch and corrects them.
 */
export function queueHoldsChangeStatsRefresh(keys: ClimbStatsKey[]): void {
  for (const key of keys) {
    queueClimbStatsRecompute(key.boardType, key.climbUuid, key.angle);
  }
}
