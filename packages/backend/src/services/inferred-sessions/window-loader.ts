import { and, asc, eq, gte, lte } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  SESSION_GAP_MS,
  expandReconciliationWindow,
  isReconciliationBoundary,
  type InferenceTick,
} from '@boardsesh/session-inference';
import { db } from '../../db/client';
import { parseClimbedAt } from './timestamps';

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
 * Start with half a day either side, then widen until both the gap and whole-day
 * rules are bounded. Early/late climbing and midnight connections need wider reads.
 */
const INITIAL_RADIUS_MS = 12 * 60 * 60 * 1000;

/**
 * Give up widening after this many doublings (12h → 192h).
 *
 * Repeated midnight connections can join many days into one window. Stop after this
 * budget and let the caller reject the incomplete window rather than split history.
 */
const MAX_WIDENINGS = 4;

type LoadedWindow = {
  /** Ticks in the gap- and UTC-day-bounded window, ascending by climbedAt. */
  ticks: InferenceTick[];
  /** True when widening hit its ceiling and the window may still be clipped. */
  truncated: boolean;
};

function toInferenceTick(row: { id: bigint | number; climbedAt: string; sessionId: string | null }): InferenceTick {
  return {
    id: Number(row.id),
    climbedAt: parseClimbedAt(row.climbedAt).getTime(),
    sessionId: row.sessionId,
  };
}

/**
 * Load every tick belonging to the run(s) around `touchedAt`, bounded on both sides by
 * a >8h gap across different UTC days.
 *
 * Reconciliation is only correct over complete runs: a window that stops mid-run would
 * let it split that run in half. The obvious query — "everything within 12h" — cannot
 * promise that, because a long session can run past the edge. So this loads a block,
 * expands within it, and reloads wider if the expansion reached the block's boundary
 * with no gap to stop at.
 *
 * Load complete UTC days as well so old same-day inferred assignments include their
 * anchors when split. This is read padding, not a grouping override.
 */
export async function loadReconciliationWindow(
  tx: ReconciliationTransaction,
  userId: string,
  touchedAt: Date,
): Promise<LoadedWindow> {
  const centre = touchedAt.getTime();
  const dayStart = Date.UTC(touchedAt.getUTCFullYear(), touchedAt.getUTCMonth(), touchedAt.getUTCDate());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;
  let radius = INITIAL_RADIUS_MS;

  for (let attempt = 0; attempt <= MAX_WIDENINGS; attempt++) {
    // Load the complete touched day plus a gap on each side immediately, avoiding
    // an extra query for ordinary morning/evening ticks. Connected days can widen.
    const from = new Date(Math.min(centre - radius, dayStart - SESSION_GAP_MS - 1));
    const to = new Date(Math.max(centre + radius, dayEnd + SESSION_GAP_MS + 1));

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

    const windowTicks = expandReconciliationWindow(loaded, centre, centre);
    if (windowTicks.length === 0) return { ticks: [], truncated: false };

    // A safe edge needs both a >8h gap and a different UTC day. If either rule
    // could reach past the loaded block, widen before making any assignments.
    const clippedStart =
      windowTicks[0].id === loaded[0].id && !isReconciliationBoundary(from.getTime(), loaded[0].climbedAt);
    const lastLoaded = loaded[loaded.length - 1];
    const clippedEnd =
      windowTicks[windowTicks.length - 1].id === lastLoaded.id &&
      !isReconciliationBoundary(lastLoaded.climbedAt, to.getTime());

    if (!clippedStart && !clippedEnd) return { ticks: windowTicks, truncated: false };

    if (attempt === MAX_WIDENINGS) return { ticks: windowTicks, truncated: true };
    radius *= 2;
  }

  return { ticks: [], truncated: false };
}
