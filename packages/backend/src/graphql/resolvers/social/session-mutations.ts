import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput, applyRateLimit, RATE_LIMIT_SESSION } from '../shared/helpers';
import { UpdateSessionInputSchema } from '../../../validation/schemas';
import { pubsub } from '../../../pubsub/index';
import type { ConnectionContext, UpdateSessionResult } from '@boardsesh/shared-schema';

type UpdateSessionInput = { sessionId: string; name?: string | null; notes?: string | null };

const SetHealthKitWorkoutIdSchema = z.object({
  sessionId: z.string().min(1),
  workoutId: z.string().min(1),
});

/**
 * Normalize a session text field on update: a trimmed-empty string or null
 * clears the field (→ null), otherwise the trimmed value is stored.
 */
function normalizeSessionText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const sessionEditMutations = {
  /**
   * Record that an explicitly-created session has been mirrored to Apple HealthKit.
   * Stores the HKWorkout UUID so the client can show "already synced" state
   * and skip duplicate writes.
   */
  setSessionHealthKitWorkoutId: async (
    _: unknown,
    args: { sessionId: string; workoutId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validated = validateInput(SetHealthKitWorkoutIdSchema, args, 'args');
    const userId = ctx.userId!;

    const [session] = await db
      .select({ createdByUserId: dbSchema.boardSessions.createdByUserId })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, validated.sessionId))
      .limit(1);

    if (!session) {
      throw new Error('Session not found');
    }

    if (session.createdByUserId !== userId) {
      const [participantTick] = await db
        .select({ uuid: dbSchema.boardseshTicks.uuid })
        .from(dbSchema.boardseshTicks)
        .where(
          and(eq(dbSchema.boardseshTicks.sessionId, validated.sessionId), eq(dbSchema.boardseshTicks.userId, userId)),
        )
        .limit(1);

      if (!participantTick) {
        throw new Error('Not a participant of this session');
      }
    }

    await db
      .insert(dbSchema.sessionHealthKitWorkouts)
      .values({
        sessionId: validated.sessionId,
        userId,
        workoutId: validated.workoutId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [dbSchema.sessionHealthKitWorkouts.sessionId, dbSchema.sessionHealthKitWorkouts.userId],
        set: {
          workoutId: validated.workoutId,
          updatedAt: new Date(),
        },
      });

    return true;
  },

  /**
   * Update a session's title and/or recap notes. Creator only; works on both
   * active and ended sessions. Partial-update semantics: only a field whose key
   * is present on the input is touched (GraphQL distinguishes an absent field
   * from an explicit null). A trimmed-empty value or null clears the field.
   * Publishes SessionNameChanged to live participants when the title actually
   * changes on an active session.
   */
  updateSession: async (
    _: unknown,
    { input }: { input: UpdateSessionInput },
    ctx: ConnectionContext,
  ): Promise<UpdateSessionResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, 'updateSession');
    const validated = validateInput(UpdateSessionInputSchema, input, 'input');
    const userId = ctx.userId!;

    const [session] = await db
      .select({
        id: dbSchema.boardSessions.id,
        createdByUserId: dbSchema.boardSessions.createdByUserId,
        name: dbSchema.boardSessions.name,
        notes: dbSchema.boardSessions.notes,
        status: dbSchema.boardSessions.status,
      })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, validated.sessionId))
      .limit(1);

    if (!session) {
      throw new Error('Session not found');
    }
    if (session.createdByUserId == null || session.createdByUserId !== userId) {
      throw new Error('Only the session creator can update this session');
    }

    // GraphQL distinguishes an absent field from an explicit null — use the
    // presence of the key on the validated input, not its value.
    const hasName = 'name' in validated;
    const hasNotes = 'notes' in validated;

    const nextName = hasName ? normalizeSessionText(validated.name) : session.name;
    const nextNotes = hasNotes ? normalizeSessionText(validated.notes) : session.notes;

    if (hasName || hasNotes) {
      const updates: Partial<typeof dbSchema.boardSessions.$inferInsert> = { lastActivity: new Date() };
      if (hasName) updates.name = nextName;
      if (hasNotes) updates.notes = nextNotes;
      await db.update(dbSchema.boardSessions).set(updates).where(eq(dbSchema.boardSessions.id, validated.sessionId));
    }

    // Broadcast a title change to live participants. Only when the name key was
    // present, the normalized value actually differs, and the session is still
    // active (an ended session has no live subscribers to update).
    if (hasName && nextName !== session.name && session.status === 'active') {
      pubsub.publishSessionEvent(validated.sessionId, {
        __typename: 'SessionNameChanged',
        name: nextName,
        changedByParticipantId: ctx.participantId ?? null,
      });
    }

    return { sessionId: validated.sessionId, name: nextName, notes: nextNotes };
  },
};
