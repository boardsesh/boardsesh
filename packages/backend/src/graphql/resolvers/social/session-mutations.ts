import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const SetHealthKitWorkoutIdSchema = z.object({
  sessionId: z.string().min(1),
  workoutId: z.string().min(1),
});

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
};
