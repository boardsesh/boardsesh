import { eq, and, sql, isNull, inArray } from 'drizzle-orm';

import type { RequestDbInstance, TransactionDb } from '../../../db/client';
import { withTransaction } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { sessionFeedQueries } from './session-feed';
import { assignInferredSession } from '../../../jobs/inferred-session-builder';
import { z } from 'zod';

const UpdateInferredSessionSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const AddUserToSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
});

const RemoveUserFromSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * Check if a user is a participant of an inferred session
 * (either the original owner or an added member via overrides).
 */
async function requireSessionParticipant(
  db: RequestDbInstance,
  sessionId: string,
  userId: string
): Promise<void> {
  // Check if user owns the session
  const [session] = await db
    .select({ userId: dbSchema.inferredSessions.userId })
    .from(dbSchema.inferredSessions)
    .where(eq(dbSchema.inferredSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error('Session not found');
  }

  if (session.userId === userId) return;

  // Check if user was added via overrides
  const [override] = await db
    .select({ id: dbSchema.sessionMemberOverrides.id })
    .from(dbSchema.sessionMemberOverrides)
    .where(
      and(
        eq(dbSchema.sessionMemberOverrides.sessionId, sessionId),
        eq(dbSchema.sessionMemberOverrides.userId, userId),
      ),
    )
    .limit(1);

  if (!override) {
    throw new Error('Not a participant of this session');
  }
}

export const sessionEditMutations = {
  /**
   * Update an inferred session's name and/or description.
   */
  updateInferredSession: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<SessionDetail | null> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validated = validateInput(UpdateInferredSessionSchema, input, 'input');
    const userId = ctx.userId!;

    await requireSessionParticipant(db, validated.sessionId, userId);

    // Build the update set
    const updateSet: Record<string, unknown> = {};
    if (validated.name !== undefined) {
      updateSet.name = validated.name;
    }
    if (validated.description !== undefined) {
      updateSet.description = validated.description;
    }

    if (Object.keys(updateSet).length > 0) {
      await db
        .update(dbSchema.inferredSessions)
        .set(updateSet)
        .where(eq(dbSchema.inferredSessions.id, validated.sessionId));
    }

    // Return updated session detail
    return sessionFeedQueries.sessionDetail(null, { sessionId: validated.sessionId }, ctx);
  },

  /**
   * Add a user to an inferred session by reassigning their overlapping ticks.
   */
  addUserToSession: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<SessionDetail | null> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validated = validateInput(AddUserToSessionSchema, input, 'input');
    const userId = ctx.userId!;

    await requireSessionParticipant(db, validated.sessionId, userId);

    // Verify the target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, validated.userId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    // Get the session's time boundaries
    const [session] = await db
      .select({
        firstTickAt: dbSchema.inferredSessions.firstTickAt,
        lastTickAt: dbSchema.inferredSessions.lastTickAt,
      })
      .from(dbSchema.inferredSessions)
      .where(eq(dbSchema.inferredSessions.id, validated.sessionId))
      .limit(1);

    if (!session) {
      throw new Error('Session not found');
    }

    // Find the target user's ticks within the session's time window (±30 min buffer)
    const ticksToReassign = await db
      .select({
        uuid: dbSchema.boardseshTicks.uuid,
        inferredSessionId: dbSchema.boardseshTicks.inferredSessionId,
        status: dbSchema.boardseshTicks.status,
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          eq(dbSchema.boardseshTicks.userId, validated.userId),
          isNull(dbSchema.boardseshTicks.sessionId), // Only non-party ticks
          sql`${dbSchema.boardseshTicks.climbedAt} >= ${session.firstTickAt}::timestamp - INTERVAL '30 minutes'`,
          sql`${dbSchema.boardseshTicks.climbedAt} <= ${session.lastTickAt}::timestamp + INTERVAL '30 minutes'`,
        ),
      );

    if (ticksToReassign.length === 0) {
      throw new Error('No ticks found for this user in the session time range');
    }

    // Collect original session IDs that will need stats recalculated
    const originalSessionIds = new Set(
      ticksToReassign
        .map((t) => t.inferredSessionId)
        .filter((id): id is string => id !== null && id !== validated.sessionId),
    );

    // Wrap tick reassignment, override insert, and stats recalculation in a transaction
    await withTransaction(async (tx) => {
      const tickUuids = ticksToReassign.map((t) => t.uuid);

      // Save previousInferredSessionId and reassign
      await tx
        .update(dbSchema.boardseshTicks)
        .set({
          previousInferredSessionId: dbSchema.boardseshTicks.inferredSessionId,
          inferredSessionId: validated.sessionId,
        })
        .where(inArray(dbSchema.boardseshTicks.uuid, tickUuids));

      // Insert session_member_overrides record
      await tx
        .insert(dbSchema.sessionMemberOverrides)
        .values({
          sessionId: validated.sessionId,
          userId: validated.userId,
          addedByUserId: userId,
        })
        .onConflictDoNothing();

      // Recalculate stats for the target session
      await recalculateSessionStats(validated.sessionId, tx);

      // Recalculate stats for original sessions (may be empty now)
      for (const origSessionId of originalSessionIds) {
        await recalculateSessionStats(origSessionId, tx);
      }
    });

    return sessionFeedQueries.sessionDetail(null, { sessionId: validated.sessionId }, ctx);
  },

  /**
   * Remove a user from an inferred session, restoring their ticks to original sessions.
   * Wrapped in a transaction to prevent concurrent modifications from leaving
   * ticks in an inconsistent state.
   */
  removeUserFromSession: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<SessionDetail | null> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validated = validateInput(RemoveUserFromSessionSchema, input, 'input');
    const userId = ctx.userId!;

    await requireSessionParticipant(db, validated.sessionId, userId);

    // Check that the user being removed is not the session owner
    const [session] = await db
      .select({ userId: dbSchema.inferredSessions.userId })
      .from(dbSchema.inferredSessions)
      .where(eq(dbSchema.inferredSessions.id, validated.sessionId))
      .limit(1);

    if (!session) {
      throw new Error('Session not found');
    }

    if (session.userId === validated.userId) {
      throw new Error('Cannot remove the session owner');
    }

    // Wrap tick restoration + override deletion + stats recalculation in a transaction
    await withTransaction(async (tx) => {
      // Find all ticks belonging to the removed user in this session
      const ticksToRestore = await tx
        .select({
          uuid: dbSchema.boardseshTicks.uuid,
          previousInferredSessionId: dbSchema.boardseshTicks.previousInferredSessionId,
        })
        .from(dbSchema.boardseshTicks)
        .where(
          and(
            eq(dbSchema.boardseshTicks.userId, validated.userId),
            eq(dbSchema.boardseshTicks.inferredSessionId, validated.sessionId),
          ),
        );

      // Collect session IDs that will receive restored ticks
      const restoredSessionIds = new Set(
        ticksToRestore
          .map((t) => t.previousInferredSessionId)
          .filter((id): id is string => id !== null),
      );

      // Restore ticks: set inferredSessionId back to previousInferredSessionId, clear previous
      if (ticksToRestore.length > 0) {
        const tickUuids = ticksToRestore.map((t) => t.uuid);

        // For ticks with previousInferredSessionId, restore them
        await tx
          .update(dbSchema.boardseshTicks)
          .set({
            inferredSessionId: dbSchema.boardseshTicks.previousInferredSessionId,
            previousInferredSessionId: null,
          })
          .where(
            and(
              inArray(dbSchema.boardseshTicks.uuid, tickUuids),
              sql`${dbSchema.boardseshTicks.previousInferredSessionId} IS NOT NULL`,
            ),
          );

        // For ticks without previousInferredSessionId (shouldn't happen, but handle gracefully),
        // reassign them immediately via the builder so they aren't left orphaned
        const orphanedTicks = ticksToRestore.filter((t) => t.previousInferredSessionId === null);
        if (orphanedTicks.length > 0) {
          // Clear inferredSessionId first so assignInferredSession can pick them up
          await tx
            .update(dbSchema.boardseshTicks)
            .set({ inferredSessionId: null })
            .where(
              and(
                inArray(dbSchema.boardseshTicks.uuid, orphanedTicks.map((t) => t.uuid)),
                eq(dbSchema.boardseshTicks.inferredSessionId, validated.sessionId),
              ),
            );

          // Fetch full tick data and reassign each via the builder
          const orphanedTickData = await tx
            .select({
              uuid: dbSchema.boardseshTicks.uuid,
              userId: dbSchema.boardseshTicks.userId,
              climbedAt: dbSchema.boardseshTicks.climbedAt,
              status: dbSchema.boardseshTicks.status,
            })
            .from(dbSchema.boardseshTicks)
            .where(inArray(dbSchema.boardseshTicks.uuid, orphanedTicks.map((t) => t.uuid)));

          for (const tick of orphanedTickData) {
            await assignInferredSession(tick.uuid, tick.userId, tick.climbedAt, tick.status, tx);
          }
        }
      }

      // Delete the session_member_overrides record
      await tx
        .delete(dbSchema.sessionMemberOverrides)
        .where(
          and(
            eq(dbSchema.sessionMemberOverrides.sessionId, validated.sessionId),
            eq(dbSchema.sessionMemberOverrides.userId, validated.userId),
          ),
        );

      // Recalculate stats within the transaction for consistent reads
      await recalculateSessionStats(validated.sessionId, tx);

      // Recalculate stats for restored sessions
      for (const restoredId of restoredSessionIds) {
        await recalculateSessionStats(restoredId, tx);
      }
    });

    return sessionFeedQueries.sessionDetail(null, { sessionId: validated.sessionId }, ctx);
  },
};

const SessionStatsRowSchema = z.object({
  tick_count: z.coerce.number(),
  total_sends: z.coerce.number(),
  total_flashes: z.coerce.number(),
  total_attempts: z.coerce.number(),
  first_tick_at: z.string().nullable(),
  last_tick_at: z.string().nullable(),
});

/**
 * Recalculate aggregate stats for an inferred session from its current ticks.
 * Must be called inside a `withTransaction` callback — the caller passes the
 * transaction handle so reads and writes see a consistent snapshot and so we
 * don't hold an extra ephemeral connection against Neon.
 */
export async function recalculateSessionStats(
  sessionId: string,
  tx: TransactionDb,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT
      COUNT(*) AS tick_count,
      COUNT(*) FILTER (WHERE status IN ('flash', 'send')) AS total_sends,
      COUNT(*) FILTER (WHERE status = 'flash') AS total_flashes,
      COUNT(*) FILTER (WHERE status = 'attempt') AS total_attempts,
      MIN(climbed_at) AS first_tick_at,
      MAX(climbed_at) AS last_tick_at
    FROM boardsesh_ticks
    WHERE inferred_session_id = ${sessionId}
  `);

  const rawRows = (result as unknown as { rows: unknown[] }).rows;
  const parsed = rawRows.length > 0 ? SessionStatsRowSchema.safeParse(rawRows[0]) : null;

  if (!parsed || !parsed.success || parsed.data.first_tick_at === null) {
    // No ticks remain — session is empty but keep it for reference
    await tx
      .update(dbSchema.inferredSessions)
      .set({
        tickCount: 0,
        totalSends: 0,
        totalFlashes: 0,
        totalAttempts: 0,
      })
      .where(eq(dbSchema.inferredSessions.id, sessionId));
    return;
  }

  const stats = parsed.data;
  await tx
    .update(dbSchema.inferredSessions)
    .set({
      tickCount: stats.tick_count,
      totalSends: stats.total_sends,
      totalFlashes: stats.total_flashes,
      totalAttempts: stats.total_attempts,
      firstTickAt: stats.first_tick_at!,
      lastTickAt: stats.last_tick_at!,
    })
    .where(eq(dbSchema.inferredSessions.id, sessionId));
}
