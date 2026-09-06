import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as dbSchema from '@boardsesh/db/schema';
import {
  reconcileWindow,
  type ExistingExplicitSession,
  type ExistingInferredSession,
  type SessionMerge,
} from '@boardsesh/session-inference';
import { logger } from '../../utils/logger';
import { loadReconciliationWindow, type ReconciliationTransaction } from './window-loader';

/**
 * Inferred sessions are off unless the deploy says otherwise.
 *
 * The backend has no feature-flag framework — the registry in `docs/feature-flags.md`
 * is a web concern — so this is an env gate, flipped per environment and rolled back by
 * unsetting it. Nothing reads inferred rows yet either, so with it off the reconciler
 * is inert.
 */
export function inferredSessionsEnabled(): boolean {
  return process.env.INFERRED_SESSIONS_ENABLED === 'true';
}

/** Move a merged-away session's social rows onto the survivor, then drop the session. */
async function applyMerge(tx: ReconciliationTransaction, merge: SessionMerge): Promise<void> {
  // Re-point BEFORE deleting. v1 deleted emptied sessions outright, orphaning their
  // votes and comments — `entity_id` is untyped text with no foreign key, so nothing
  // caught it and migration 0120 had to sweep the debris up afterwards.
  for (const table of [dbSchema.votes, dbSchema.comments] as const) {
    await tx
      .update(table)
      .set({ entityId: merge.survivorId })
      .where(and(eq(table.entityType, 'session'), eq(table.entityId, merge.loserId)));
  }
  await tx
    .delete(dbSchema.voteCounts)
    .where(and(eq(dbSchema.voteCounts.entityType, 'session'), eq(dbSchema.voteCounts.entityId, merge.loserId)));

  await tx.delete(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, merge.loserId));
}

/**
 * Reassign the ticks around `touchedAt` to the sessions they belong to.
 *
 * Runs inside the caller's transaction so a tick and its session assignment commit or
 * roll back together. Safe to call from every writer — save, edit, delete, importer,
 * offline drain — because {@link reconcileWindow} returns the same answer for a window
 * however many times it is applied.
 *
 * Concurrency is settled by the unique partial index on `board_sessions.anchor_tick_id`:
 * two writers reconciling the same unassigned run both decide to create a session, and
 * the loser's insert raises a unique violation that rolls its transaction back. The
 * caller retries the tick write, and the second pass finds the anchor and inherits it.
 */
export async function reconcileInferredSessions(
  tx: ReconciliationTransaction,
  userId: string,
  touchedAt: Date,
): Promise<void> {
  if (!inferredSessionsEnabled()) return;

  const { ticks, truncated } = await loadReconciliationWindow(tx, userId, touchedAt);
  if (truncated) {
    logger.warn(
      `[inferredSessions] window for ${userId} around ${touchedAt.toISOString()} hit the widening ceiling; reconciling the clipped range`,
    );
  }
  if (ticks.length === 0) return;

  const tickIds = ticks.map((tick) => tick.id);
  const assignedIds = [...new Set(ticks.map((tick) => tick.sessionId).filter((id): id is string => id !== null))];

  // Sessions in play: those the window's ticks already point at, plus any anchored on a
  // tick inside it (an inferred session whose ticks all moved away still owns its
  // anchor, and must be recognised rather than duplicated).
  const sessionRows =
    assignedIds.length > 0 || tickIds.length > 0
      ? await tx
          .select({
            id: dbSchema.boardSessions.id,
            origin: dbSchema.boardSessions.origin,
            anchorTickId: dbSchema.boardSessions.anchorTickId,
            userEdited: dbSchema.boardSessions.userEdited,
          })
          .from(dbSchema.boardSessions)
          .where(
            or(
              assignedIds.length > 0 ? inArray(dbSchema.boardSessions.id, assignedIds) : sql`false`,
              and(eq(dbSchema.boardSessions.origin, 'inferred'), inArray(dbSchema.boardSessions.anchorTickId, tickIds)),
            ),
          )
      : [];

  const existingInferred: ExistingInferredSession[] = sessionRows
    .filter((row) => row.origin === 'inferred')
    .map((row) => ({ id: row.id, anchorTickId: row.anchorTickId, userEdited: row.userEdited }));

  // Explicit sessions are matched by day, so their own tick spans are what matter —
  // not the window's bounds, which is why this reads the ticks rather than the session
  // rows' started_at/ended_at (those are wall-clock, and an inferred day is derived
  // from climbed_at).
  const explicitIds = sessionRows.filter((row) => row.origin === 'explicit').map((row) => row.id);
  const explicitSpans = explicitIds.length
    ? await tx
        .select({
          sessionId: dbSchema.boardseshTicks.sessionId,
          firstTickAt: sql<string>`MIN(${dbSchema.boardseshTicks.climbedAt})`,
          lastTickAt: sql<string>`MAX(${dbSchema.boardseshTicks.climbedAt})`,
        })
        .from(dbSchema.boardseshTicks)
        .where(inArray(dbSchema.boardseshTicks.sessionId, explicitIds))
        .groupBy(dbSchema.boardseshTicks.sessionId)
    : [];

  const existingExplicit: ExistingExplicitSession[] = explicitSpans
    .filter((row): row is typeof row & { sessionId: string } => row.sessionId !== null)
    .map((row) => ({
      id: row.sessionId,
      firstTickAt: new Date(row.firstTickAt).getTime(),
      lastTickAt: new Date(row.lastTickAt).getTime(),
    }));

  const result = reconcileWindow({ ticks, existingInferred, existingExplicit });

  for (const merge of result.merges) {
    await applyMerge(tx, merge);
  }

  for (const runResult of result.runs) {
    let sessionId = runResult.sessionId;

    if (sessionId === null) {
      sessionId = uuidv4();
      await tx.insert(dbSchema.boardSessions).values({
        id: sessionId,
        // No board path: the run's ticks may span several boards, and nothing about an
        // inferred session is joinable anyway.
        boardPath: null,
        origin: 'inferred',
        createdByUserId: userId,
        // Already over by construction, with its bounds taken from the climbing rather
        // than from a clock. The auto-end sweep skips origin='inferred' regardless.
        status: 'ended',
        startedAt: new Date(runResult.firstTickAt),
        endedAt: new Date(runResult.lastTickAt),
        lastActivity: new Date(runResult.lastTickAt),
        isPermanent: false,
        isPublic: true,
        anchorTickId: runResult.anchorTickId,
      });
    } else {
      // An inherited session's span moves as ticks join and leave it.
      await tx
        .update(dbSchema.boardSessions)
        .set({
          startedAt: new Date(runResult.firstTickAt),
          endedAt: new Date(runResult.lastTickAt),
          lastActivity: new Date(runResult.lastTickAt),
        })
        .where(and(eq(dbSchema.boardSessions.id, sessionId), eq(dbSchema.boardSessions.origin, 'inferred')));
    }

    await tx
      .update(dbSchema.boardseshTicks)
      .set({ sessionId })
      // `boardsesh_ticks.id` is a bigserial read as bigint, while the algorithm works
      // in numbers. The table is ~500k rows, so the round trip is nowhere near the
      // safe-integer ceiling.
      .where(inArray(dbSchema.boardseshTicks.id, runResult.tickIds.map(BigInt)));
  }

  // Sessions an explicit session took every tick from. Their social rows have nowhere
  // sensible to go — the ticks are spread across a session that already has its own —
  // so they are dropped with the row rather than left dangling.
  if (result.emptiedSessionIds.length > 0) {
    for (const table of [dbSchema.votes, dbSchema.comments] as const) {
      await tx
        .delete(table)
        .where(and(eq(table.entityType, 'session'), inArray(table.entityId, result.emptiedSessionIds)));
    }
    await tx
      .delete(dbSchema.voteCounts)
      .where(
        and(
          eq(dbSchema.voteCounts.entityType, 'session'),
          inArray(dbSchema.voteCounts.entityId, result.emptiedSessionIds),
        ),
      );
    await tx
      .delete(dbSchema.boardSessions)
      .where(
        and(
          inArray(dbSchema.boardSessions.id, result.emptiedSessionIds),
          eq(dbSchema.boardSessions.origin, 'inferred'),
        ),
      );
  }
}

/** Convenience for callers holding a `climbed_at` string rather than a Date. */
export async function reconcileInferredSessionsAt(
  tx: ReconciliationTransaction,
  userId: string,
  climbedAt: string | Date,
): Promise<void> {
  await reconcileInferredSessions(tx, userId, climbedAt instanceof Date ? climbedAt : new Date(climbedAt));
}
