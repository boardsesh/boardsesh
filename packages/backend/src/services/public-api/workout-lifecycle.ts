import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import { appWorkouts, appWorkoutRequests } from '@boardsesh/db/schema';
import { users } from '@boardsesh/db/schema/auth';
import type { PartnerDatabase } from '../../auth/partner/tables';
import { lockPartnerConnection } from '../../auth/partner/locks';
import { enqueuePartnerWebhookEvent } from '../partner-webhooks/events';
import { lockAppWorkoutSession, type AppWorkoutRow } from './workouts';

/** Lock the whole party before any connection; an app owner may also be a participant. */
export async function lockSessionAppWorkoutUsers(transaction: PartnerDatabase, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await transaction
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.id,
        transaction
          .select({ userId: appWorkouts.userId })
          .from(appWorkouts)
          .where(and(inArray(appWorkouts.sessionId, sessionIds), eq(appWorkouts.status, 'started'))),
      ),
    )
    .orderBy(asc(users.id))
    .for('share');
}

/** Run before locking/updating the session, using the caller's existing pool/transaction. */
export async function lockSessionAppWorkouts(
  transaction: PartnerDatabase,
  sessionId: string,
): Promise<AppWorkoutRow[]> {
  await lockAppWorkoutSession(transaction, sessionId);
  await lockSessionAppWorkoutUsers(transaction, [sessionId]);
  const candidates = await transaction
    .select()
    .from(appWorkouts)
    .where(and(eq(appWorkouts.sessionId, sessionId), eq(appWorkouts.status, 'started')))
    .orderBy(asc(appWorkouts.userId), asc(appWorkouts.clientId));
  const locked: AppWorkoutRow[] = [];
  for (const candidate of candidates) {
    const connection = await lockPartnerConnection(transaction, candidate.userId, candidate.clientId);
    if (!connection || connection.revokedAt || connection.generation !== candidate.connectionGeneration) continue;
    const [workout] = await transaction
      .select()
      .from(appWorkouts)
      .where(and(eq(appWorkouts.id, candidate.id), eq(appWorkouts.status, 'started')))
      .for('update');
    if (workout) locked.push(workout);
  }
  return locked;
}

export async function completeSessionAppWorkouts(
  transaction: PartnerDatabase,
  workouts: AppWorkoutRow[],
  completion: 'completed' | 'auto_closed',
  now: Date,
): Promise<void> {
  for (const workout of workouts) {
    const updated = await transaction
      .update(appWorkouts)
      .set({ status: completion, completedAt: now })
      .where(and(eq(appWorkouts.id, workout.id), eq(appWorkouts.status, 'started')))
      .returning({ id: appWorkouts.id });
    if (updated.length)
      await enqueuePartnerWebhookEvent(transaction, {
        clientId: workout.clientId,
        connectionId: workout.connectionId,
        connectionGeneration: workout.connectionGeneration,
        type: 'workout.completed',
        workoutId: workout.id,
        occurredAt: now,
      });
  }
}

export async function expireAppWorkouts(transaction: PartnerDatabase, now = new Date()): Promise<number> {
  const candidates = await transaction
    .select({ id: appWorkouts.id })
    .from(appWorkouts)
    .where(and(inArray(appWorkouts.status, ['created', 'opened']), lte(appWorkouts.expiresAt, now)))
    .orderBy(asc(appWorkouts.expiresAt), asc(appWorkouts.id))
    .limit(1000)
    .for('update', { skipLocked: true });
  const expired = candidates.length
    ? await transaction
        .update(appWorkouts)
        .set({ status: 'expired' })
        .where(
          inArray(
            appWorkouts.id,
            candidates.map((workout) => workout.id),
          ),
        )
        .returning({ id: appWorkouts.id })
    : [];
  const requests = await transaction
    .select({ clientId: appWorkoutRequests.clientId, userId: appWorkoutRequests.userId, key: appWorkoutRequests.key })
    .from(appWorkoutRequests)
    .where(lte(appWorkoutRequests.expiresAt, now))
    .orderBy(asc(appWorkoutRequests.expiresAt))
    .limit(1000)
    .for('update', { skipLocked: true });
  if (requests.length)
    await transaction
      .delete(appWorkoutRequests)
      .where(
        or(
          ...requests.map((request) =>
            and(
              eq(appWorkoutRequests.clientId, request.clientId),
              eq(appWorkoutRequests.userId, request.userId),
              eq(appWorkoutRequests.key, request.key),
            ),
          ),
        ),
      );
  return expired.length;
}
