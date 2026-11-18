import { and, asc, eq, gt, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import {
  appWorkouts,
  boardseshTicks,
  oauthClientWebhooks,
  partnerWebhookOutbox,
  partnerWorkoutResultDebounce,
} from '@boardsesh/db/schema';
import type { FeedTransaction } from '../logbook-feed';
import { enqueuePartnerWebhookEvent } from './events';

/** A results change this long after End no longer re-sends `workout.completed`. */
export const WORKOUT_RESULT_RESEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** At most one `workout.completed` per workout in this interval, End's included. */
export const WORKOUT_RESULT_RESEND_INTERVAL_MS = 60_000;
const FINISHED_WORKOUT_STATUSES = ['completed', 'auto_closed'];

type TickChange = { userId: string; tickUuid: string };
type FinishedWorkout = { id: string; userId: string; sessionId: string | null; completedAt: Date | null };

/**
 * Marks finished workouts whose results a page of `logbook_changes` touched:
 * a tick of the workout's climber in the workout's session, inserted, edited
 * or deleted. The page sits below the feed horizon, so every change in it has
 * committed.
 *
 * A workout whose completion event is still unsent is skipped: that event
 * reaches the app after this change committed, so the app's read already sees
 * it. That also covers the common case of a last tick saved just before End.
 */
export async function markChangedWorkoutResults(
  transaction: FeedTransaction,
  changes: readonly TickChange[],
  now = new Date(),
): Promise<void> {
  if (changes.length === 0) return;
  const changedUserIds = [...new Set(changes.map((change) => change.userId))];
  const workouts: FinishedWorkout[] = await transaction
    .select({
      id: appWorkouts.id,
      userId: appWorkouts.userId,
      sessionId: appWorkouts.sessionId,
      completedAt: appWorkouts.completedAt,
    })
    .from(appWorkouts)
    .innerJoin(oauthClientWebhooks, eq(oauthClientWebhooks.clientId, appWorkouts.clientId))
    .where(
      and(
        inArray(appWorkouts.userId, changedUserIds),
        inArray(appWorkouts.status, FINISHED_WORKOUT_STATUSES),
        gt(appWorkouts.completedAt, new Date(now.getTime() - WORKOUT_RESULT_RESEND_WINDOW_MS)),
        eq(oauthClientWebhooks.enabled, true),
        sql`'workout.completed' = any(${oauthClientWebhooks.events})`,
        notExists(
          transaction
            .select({ id: partnerWebhookOutbox.id })
            .from(partnerWebhookOutbox)
            .where(
              and(
                eq(partnerWebhookOutbox.workoutId, appWorkouts.id),
                eq(partnerWebhookOutbox.type, 'workout.completed'),
                isNull(partnerWebhookOutbox.relayedAt),
              ),
            ),
        ),
      ),
    );
  if (workouts.length === 0) return;

  const workoutsByUser = new Map<string, FinishedWorkout[]>();
  for (const workout of workouts) {
    workoutsByUser.set(workout.userId, [...(workoutsByUser.get(workout.userId) ?? []), workout]);
  }
  const relevantChanges = changes.filter((change) => workoutsByUser.has(change.userId));
  const ticks = await transaction
    .select({ uuid: boardseshTicks.uuid, userId: boardseshTicks.userId, sessionId: boardseshTicks.sessionId })
    .from(boardseshTicks)
    .where(inArray(boardseshTicks.uuid, [...new Set(relevantChanges.map((change) => change.tickUuid))]));
  const ticksByUuid = new Map(ticks.map((tick) => [tick.uuid, tick]));

  const changedWorkouts = new Map<string, FinishedWorkout>();
  for (const change of relevantChanges) {
    const tick = ticksByUuid.get(change.tickUuid);
    // A deleted tick (or one handed to another climber) no longer names the
    // session it was in, so it counts against every recent workout of its
    // climber. A repeat costs the app one extra read; a miss loses a tick.
    const leftClimber = !tick || tick.userId !== change.userId;
    for (const workout of workoutsByUser.get(change.userId) ?? []) {
      if (leftClimber || (workout.sessionId !== null && tick.sessionId === workout.sessionId)) {
        changedWorkouts.set(workout.id, workout);
      }
    }
  }
  if (changedWorkouts.size === 0) return;

  await transaction
    .insert(partnerWorkoutResultDebounce)
    .values(
      [...changedWorkouts.values()].map((workout) => ({
        workoutId: workout.id,
        // End's own event counts as the first send of the interval.
        lastEnqueuedAt: workout.completedAt ?? now,
        pending: true,
      })),
    )
    .onConflictDoUpdate({ target: partnerWorkoutResultDebounce.workoutId, set: { pending: true } });
}

/**
 * Re-sends `workout.completed` (a new event id, the same workout id) for every
 * marked workout whose last send is at least a minute old. Returns how many it
 * handled; 100 means more may be waiting.
 */
export async function enqueueChangedWorkoutResults(transaction: FeedTransaction, now = new Date()): Promise<number> {
  const ready = await transaction
    .select({
      workoutId: appWorkouts.id,
      clientId: appWorkouts.clientId,
      connectionId: appWorkouts.connectionId,
      connectionGeneration: appWorkouts.connectionGeneration,
    })
    .from(partnerWorkoutResultDebounce)
    .innerJoin(appWorkouts, eq(appWorkouts.id, partnerWorkoutResultDebounce.workoutId))
    .where(
      and(
        eq(partnerWorkoutResultDebounce.pending, true),
        lt(partnerWorkoutResultDebounce.lastEnqueuedAt, new Date(now.getTime() - WORKOUT_RESULT_RESEND_INTERVAL_MS)),
      ),
    )
    .orderBy(asc(partnerWorkoutResultDebounce.lastEnqueuedAt))
    .limit(100);
  for (const workout of ready) {
    // Checks the endpoint, its subscription and the connection generation; a
    // disconnected climber's app hears nothing.
    await enqueuePartnerWebhookEvent(transaction, {
      clientId: workout.clientId,
      connectionId: workout.connectionId,
      connectionGeneration: workout.connectionGeneration,
      type: 'workout.completed',
      workoutId: workout.workoutId,
      occurredAt: now,
    });
    await transaction
      .update(partnerWorkoutResultDebounce)
      .set({ pending: false, lastEnqueuedAt: now })
      .where(eq(partnerWorkoutResultDebounce.workoutId, workout.workoutId));
  }
  return ready.length;
}
