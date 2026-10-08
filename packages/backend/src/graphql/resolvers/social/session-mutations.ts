import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput, applyRateLimit, RATE_LIMIT_SESSION } from '../shared/helpers';
import { UpdateSessionInputSchema } from '../../../validation/schemas';
import { pubsub } from '../../../pubsub/index';
import type { ConnectionContext, UpdateSessionResult } from '@boardsesh/shared-schema';
import { republishBoardQueuePreviewsForSession } from '../../../services/board-queue-preview';
import { logger } from '../../../utils/logger';
import { legacyResourceAudience } from '../../../services/privacy';

type UpdateSessionInput = { sessionId: string; name?: string | null; notes?: string | null; isPublic?: boolean | null };

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
   * Update a session's title, recap notes and/or visibility. Creator only;
   * works on both active and ended sessions. Partial-update semantics: only a
   * field whose key is present on the input is touched (GraphQL distinguishes
   * an absent field from an explicit null). A trimmed-empty value or null
   * clears a text field; a null `isPublic` leaves visibility unchanged.
   * Publishes SessionNameChanged to live participants when the title actually
   * changes on an active session.
   *
   * Legacy visibility edits retain newer restrictive resource audiences. Safe
   * narrowing still re-drives the live listings and board queue preview; the
   * explicit audience control is required to widen a protected session.
   *
   * `lastActivity` moves only when the title or notes change. It is the
   * live-sessions dormancy clock, so a visibility-only edit on a dormant
   * session must not advertise it as climbing right now.
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
        isPublic: dbSchema.boardSessions.isPublic,
        boardId: dbSchema.boardSessions.boardId,
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
    // A boolean has no "cleared" state, so an explicit null is a no-op too.
    const hasIsPublic = typeof validated.isPublic === 'boolean';

    const nextName = hasName ? normalizeSessionText(validated.name) : session.name;
    const nextNotes = hasNotes ? normalizeSessionText(validated.notes) : session.notes;
    let nextIsPublic = typeof validated.isPublic === 'boolean' ? validated.isPublic : session.isPublic;

    if (hasName || hasNotes || hasIsPublic) {
      const updates: Partial<typeof dbSchema.boardSessions.$inferInsert> = {};
      if (hasName || hasNotes) updates.lastActivity = new Date();
      if (hasName) updates.name = nextName;
      if (hasNotes) updates.notes = nextNotes;
      if (hasIsPublic) updates.isPublic = nextIsPublic;
      await db.transaction(async (transaction) => {
        const [locked] = await transaction
          .select({ ownerId: dbSchema.boardSessions.createdByUserId, isPublic: dbSchema.boardSessions.isPublic })
          .from(dbSchema.boardSessions)
          .where(eq(dbSchema.boardSessions.id, validated.sessionId))
          .for('update');
        if (!locked || locked.ownerId !== userId) throw new Error('Only the session creator can update this session');
        if (hasIsPublic && nextIsPublic !== locked.isPublic) {
          const policyCondition = and(
            eq(dbSchema.resourcePrivacy.kind, 'session'),
            eq(dbSchema.resourcePrivacy.resourceId, validated.sessionId),
          );
          const [policy] = await transaction.select().from(dbSchema.resourcePrivacy).where(policyCondition).limit(1);
          const audience = legacyResourceAudience(policy?.audience, nextIsPublic ? 'public' : 'invite_only');
          nextIsPublic = audience === 'public';
          updates.isPublic = nextIsPublic;
          if (policy && audience !== policy.audience) {
            await transaction
              .update(dbSchema.resourcePrivacy)
              .set({ audience, revision: sql`${dbSchema.resourcePrivacy.revision} + 1`, updatedAt: new Date() })
              .where(policyCondition);
          }
        }
        await transaction
          .update(dbSchema.boardSessions)
          .set(updates)
          .where(eq(dbSchema.boardSessions.id, validated.sessionId));
      });
    }

    // Kiosks showing this session's queue must follow a visibility flip: the
    // preview producer only re-gates on queue events, and a flip is not one.
    // Re-resolve every board the session can be previewed on — the Redis
    // binding AND the durable board_id fallback — so each kiosk ends up on
    // whatever the preview gates now allow. Best-effort: a failed kiosk update
    // must not fail the edit the creator asked for.
    if (hasIsPublic) pubsub.publishPrivacyChanged();
    if (hasIsPublic && nextIsPublic !== session.isPublic && session.status === 'active') {
      await republishBoardQueuePreviewsForSession(validated.sessionId, session.boardId).catch((error: unknown) => {
        // error, not warn: after a flip to private, a failed republish leaves
        // the session's queue on the wall kiosk until its next queue event.
        logger.error('[updateSession] board-queue-preview republish failed after a visibility change', {
          sessionId: validated.sessionId,
          isPublic: nextIsPublic,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      });
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

    return { sessionId: validated.sessionId, name: nextName, notes: nextNotes, isPublic: nextIsPublic };
  },
};
