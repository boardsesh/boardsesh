import { GraphQLError } from 'graphql';
import { and, eq } from 'drizzle-orm';
import { CreateWorkoutSchema } from '@boardsesh/public-api';
import { appWorkouts, sessionWorkouts } from '@boardsesh/db/schema';
import { oauthClient } from '@boardsesh/db/schema/auth';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { readPartnerOAuthMode } from '../../../auth/partner/mode';
import type { PartnerDatabase } from '../../../auth/partner/tables';
import {
  lockAppWorkoutForUser,
  lockAppWorkoutSession,
  lockAppWorkoutStart,
  attachLockedAppWorkout,
  recordAppWorkoutPlan,
  presentCreatedWorkout,
  AppWorkoutError,
} from '../../../services/public-api/workouts';
import { appWorkoutGraphError } from './errors';
import { requireAuthenticated, applyRateLimit } from '../shared/helpers';

function requireAvailable(): void {
  const mode = readPartnerOAuthMode();
  if (mode === 'off') throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
  if (mode === 'hold')
    throw new GraphQLError('Partner workouts are paused', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
}
function graphError(error: unknown): never {
  if (error instanceof AppWorkoutError) throw appWorkoutGraphError(error);
  throw error;
}

export const appWorkoutQueries = {
  appWorkout: async (_: unknown, { id }: { id: string }, ctx: ConnectionContext) => {
    requireAvailable();
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'appWorkout');
    const userId = ctx.userId!;
    const [hint] = await db.select({ userId: appWorkouts.userId }).from(appWorkouts).where(eq(appWorkouts.id, id));
    if (!hint) throw new GraphQLError('Workout unavailable', { extensions: { code: 'NOT_FOUND' } });
    if (hint.userId !== userId) {
      await db.update(appWorkouts).set({ openedByMismatch: true }).where(eq(appWorkouts.id, id));
      throw new GraphQLError('This workout was sent to a different Boardsesh account', {
        extensions: { code: 'FORBIDDEN', reason: 'APP_WORKOUT_ACCOUNT_MISMATCH' },
      });
    }
    try {
      return await db.transaction(async (tx) => {
        const transaction = tx as unknown as PartnerDatabase;
        let workout = await lockAppWorkoutForUser(transaction, userId, id);
        if (workout.status === 'created') {
          const [opened] = await transaction
            .update(appWorkouts)
            .set({ status: 'opened', openedAt: new Date() })
            .where(eq(appWorkouts.id, id))
            .returning();
          workout = opened;
        }
        const [app] = await transaction
          .select({ name: oauthClient.name })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, workout.clientId));
        const [sessionPlan] = workout.sessionId
          ? await transaction
              .select({ plan: sessionWorkouts.plan })
              .from(sessionWorkouts)
              .where(and(eq(sessionWorkouts.sessionId, workout.sessionId), eq(sessionWorkouts.userId, userId)))
          : [];
        const spec = CreateWorkoutSchema.parse(workout.spec);
        return {
          ...presentCreatedWorkout(workout),
          title: workout.title,
          clientId: workout.clientId,
          sessionId: workout.sessionId,
          sessionPlan: sessionPlan?.plan ?? null,
          sourceAppName: app?.name ?? '',
          notes: spec.notes ?? null,
          scheduledFor: spec.scheduledFor ?? null,
          spec,
          openedByMismatch: workout.openedByMismatch,
        };
      });
    } catch (error) {
      return graphError(error);
    }
  },
  publicAppWorkoutLaunch: async (_: unknown, { id }: { id: string }, ctx: ConnectionContext) => {
    requireAvailable();
    await applyRateLimit(ctx, 30, 'publicAppWorkoutLaunch');
    const [workout] = await db
      .select({ sourceAppName: oauthClient.name, disabled: oauthClient.disabled })
      .from(appWorkouts)
      .innerJoin(oauthClient, eq(oauthClient.clientId, appWorkouts.clientId))
      .where(eq(appWorkouts.id, id));
    return workout && !workout.disabled ? { sourceAppName: workout.sourceAppName ?? '' } : null;
  },
};
export const appWorkoutMutations = {
  attachAppWorkout: async (
    _: unknown,
    { workoutId, sessionId }: { workoutId: string; sessionId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAvailable();
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'attachAppWorkout');
    try {
      await db.transaction(async (tx) => {
        const transaction = tx as unknown as PartnerDatabase;
        await lockAppWorkoutStart(transaction, workoutId);
        await lockAppWorkoutSession(transaction, sessionId);
        const workout = await lockAppWorkoutForUser(transaction, ctx.userId!, workoutId);
        // Active queues use Redis CAS while attachment is a Postgres transaction.
        // A fresh seeded session is the atomic path for the complete round plan.
        if (
          workout.status !== 'started' &&
          CreateWorkoutSchema.parse(workout.spec).blocks.some((block) => block.type === 'fourByFour')
        )
          throw new AppWorkoutError(
            409,
            'conflict',
            'End the current session, then start this round workout in a new session.',
            undefined,
            undefined,
            'APP_WORKOUT_NEW_SESSION_REQUIRED',
          );
        await attachLockedAppWorkout(transaction, workout, sessionId);
      });
      return true;
    } catch (error) {
      return graphError(error);
    }
  },
  recordAppWorkoutPlan: async (
    _: unknown,
    { workoutId, plan }: { workoutId: string; plan: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAvailable();
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'recordAppWorkoutPlan');
    try {
      await db.transaction((tx) =>
        recordAppWorkoutPlan(tx as unknown as PartnerDatabase, ctx.userId!, workoutId, plan),
      );
      return true;
    } catch (error) {
      return graphError(error);
    }
  },
};
