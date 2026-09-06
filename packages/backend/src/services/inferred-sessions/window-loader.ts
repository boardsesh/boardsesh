import { and, asc, eq, gte, lte } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { SESSION_GAP_MS, expandWindow, type InferenceTick } from '@boardsesh/session-inference';
import { db } from '../../db/client';

/**
 * The transaction handle the tick mutations already open. Reconciliation runs inside
 * that same transaction so a tick and its session assignment commit together — v1 fired
 * assignment after the insert and outside the transaction, with the failure swallowed,
 * so a hiccup left ticks unassigned until the nightly cron caught them.
 */
export type ReconciliationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * How wide a slice of the climber's ticks to pull on the first attempt.
 *
 * Runs are short — median 5 ticks, p90 15, and only 1.2% span midnight — so half a day
 * either side covers essentially every one in a single query.
 */
const INITIAL_RADIUS_MS = 12 * 60 * 60 * 1000;

/**
 * Give up widening after this many doublings (12h → 192h).
 *
 * Reaching it would mean an unbroken chain of ticks less than 4h apart stretching over
 * a week, which is not climbing. Bailing out keeps a pathological row from turning one
 * tick write into an unbounded scan.
 */
const MAX_WIDENINGS = 4;

type LoadedWindow = {
  /** Ticks in the gap-bounded window, ascending by climbedAt. */
  ticks: InferenceTick[];
  /** True when widening hit its ceiling and the window may still be clipped. */
  truncated: boolean;
};

function toInferenceTick(row: { id: bigint | number; climbedAt: string; sessionId: string | null }): InferenceTick {
  return {
    id: Number(row.id),
    climbedAt: new Date(row.climbedAt).getTime(),
    sessionId: row.sessionId,
  };
}

/**
 * Load every tick belonging to the run(s) around `touchedAt`, bounded on both sides by
 * a real gap.
 *
 * Reconciliation is only correct over complete runs: a window that stops mid-run would
 * let it split that run in half. The obvious query — "everything within 12h" — cannot
 * promise that, because a long session can run past the edge. So this loads a block,
 * expands within it, and reloads wider if the expansion reached the block's boundary
 * with no gap to stop at.
 *
 * In practice the first query is enough; the loop exists so that the guarantee holds
 * rather than usually holding.
 */
export async function loadReconciliationWindow(
  tx: ReconciliationTransaction,
  userId: string,
  touchedAt: Date,
): Promise<LoadedWindow> {
  const centre = touchedAt.getTime();
  let radius = INITIAL_RADIUS_MS;

  for (let attempt = 0; attempt <= MAX_WIDENINGS; attempt++) {
    const from = new Date(centre - radius);
    const to = new Date(centre + radius);

    const rows = await tx
      .select({
        id: dbSchema.boardseshTicks.id,
        climbedAt: dbSchema.boardseshTicks.climbedAt,
        sessionId: dbSchema.boardseshTicks.sessionId,
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          eq(dbSchema.boardseshTicks.userId, userId),
          gte(dbSchema.boardseshTicks.climbedAt, from.toISOString()),
          lte(dbSchema.boardseshTicks.climbedAt, to.toISOString()),
        ),
      )
      .orderBy(asc(dbSchema.boardseshTicks.climbedAt), asc(dbSchema.boardseshTicks.id));

    const loaded = rows.map(toInferenceTick);
    if (loaded.length === 0) return { ticks: [], truncated: false };

    const windowTicks = expandWindow(loaded, centre, centre);
    if (windowTicks.length === 0) return { ticks: [], truncated: false };

    // Expansion stops at a >4h gap. If it instead stopped because it ran out of loaded
    // rows, there may be more of this run just outside the block — widen and retry.
    const clippedStart = windowTicks[0].id === loaded[0].id && loaded[0].climbedAt - from.getTime() <= SESSION_GAP_MS;
    const lastLoaded = loaded[loaded.length - 1];
    const clippedEnd =
      windowTicks[windowTicks.length - 1].id === lastLoaded.id && to.getTime() - lastLoaded.climbedAt <= SESSION_GAP_MS;

    if (!clippedStart && !clippedEnd) return { ticks: windowTicks, truncated: false };

    if (attempt === MAX_WIDENINGS) return { ticks: windowTicks, truncated: true };
    radius *= 2;
  }

  return { ticks: [], truncated: false };
}
