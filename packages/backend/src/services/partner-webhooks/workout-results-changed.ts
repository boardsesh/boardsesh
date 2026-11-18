import { and, asc, eq, gt, inArray, isNull, lt, notExists, sql, type SQL } from 'drizzle-orm';
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
 * Finished workouts an app could be told about again: ended under seven days
 * ago, for an app with an enabled `workout.completed` subscription, and with no
 * completion event still waiting to be relayed. That waiting event reaches the
 * app after the change committed, so the app's read already sees it; this also
 * covers the common case of a last tick saved just before End.
 *
 * Lock order: the workout row, then its debounce row. `recordSessionWorkout`
 * holds the workout `FOR UPDATE` (recoverAppWorkoutPlan) before it marks, so
 * the producer takes `FOR KEY SHARE` here, in id order, before it inserts a
 * debounce row whose foreign-key check would otherwise ask for that lock while
 * already holding the new row: a deadlock. The producer's earlier cursor
 * `FOR UPDATE` is a row no other path takes, so it adds no cycle.
 */
function resendableWorkouts(
  transaction: FeedTransaction,
  scope: SQL | undefined,
  now: Date,
): Promise<FinishedWorkout[]> {
  return transaction
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
        scope,
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
    )
    .orderBy(asc(appWorkouts.id))
    .for('key share', { of: appWorkouts });
}

/** Queues a re-send for each workout; the minute job sends it once its spacing allows. */
export async function markWorkoutResultsChanged(
  transaction: FeedTransaction,
  workouts: ReadonlyArray<Pick<FinishedWorkout, 'id' | 'completedAt'>>,
  now = new Date(),
): Promise<void> {
  if (workouts.length === 0) return;
  await transaction
    .insert(partnerWorkoutResultDebounce)
    .values(
      workouts.map((workout) => ({
        workoutId: workout.id,
        // End's own event counts as the first send of the interval.
        lastEnqueuedAt: workout.completedAt ?? now,
        pending: true,
      })),
    )
    .onConflictDoUpdate({ target: partnerWorkoutResultDebounce.workoutId, set: { pending: true } });
}

/**
 * For a write that changes a climber's results in one session without a tick
 * change: the session's tick map or plan (`recordSessionWorkout`), which places
 * ticks on blocks. Call inside that write's transaction.
 */
export async function markSessionWorkoutResultsChanged(
  transaction: FeedTransaction,
  sessionId: string,
  userId: string,
  now = new Date(),
): Promise<void> {
  const workouts = await resendableWorkouts(
    transaction,
    and(eq(appWorkouts.sessionId, sessionId), eq(appWorkouts.userId, userId)),
    now,
  );
  await markWorkoutResultsChanged(transaction, workouts, now);
}

/**
 * Marks finished workouts whose results a page of `logbook_changes` touched:
 * a tick of the workout's climber in the workout's session, inserted, edited
 * or deleted. The page sits below the feed horizon, so every change in it has
 * committed.
 */
export async function markChangedWorkoutResults(
  transaction: FeedTransaction,
  changes: readonly TickChange[],
  now = new Date(),
): Promise<void> {
  if (changes.length === 0) return;
  const changedUserIds = [...new Set(changes.map((change) => change.userId))];
  const workouts = await resendableWorkouts(transaction, inArray(appWorkouts.userId, changedUserIds), now);
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
    // A tick moved to another session is seen only by the session it joined:
    // safe while ticks never leave an explicit session (inferred-sessions
    // reconcile refuses to) and workouts bind only explicit sessions.
    const leftClimber = !tick || tick.userId !== change.userId;
    for (const workout of workoutsByUser.get(change.userId) ?? []) {
      if (leftClimber || (workout.sessionId !== null && tick.sessionId === workout.sessionId)) {
        changedWorkouts.set(workout.id, workout);
      }
    }
  }
  await markWorkoutResultsChanged(transaction, [...changedWorkouts.values()], now);
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
