// Sends the phone's workout to the server (#6903) through the offline outbox:
// at Start, at "Add a block", and once more just before END_SESSION with the
// tick map from the run's tick log. docs/workout-stages.md, "Workouts on the
// server" and "The write path".
//
// Each write carries the whole workout at a new revision, and the server keeps
// it only when that revision beats the stored one, so a replay is a no-op and
// an older write can't roll a newer one back. A newer write replaces the ones
// for the same session still waiting in the outbox.
//
// FIFO matters: the server keeps a tick-map entry only when that tick is
// already one of the climber's ticks in the session. The outbox drains in
// order, so a write queued after the ticks lands after them.

import type { QueryClient } from '@tanstack/react-query';
import type { ClimbQueueItem } from '@boardsesh/queue';
import {
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  beginImmediateWrite,
  enqueue,
  processMutation,
  removePendingSessionWorkouts,
  runLocalWriteWithRetry,
  type GraphQLFetch,
  type PendingMutation,
} from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { reportHandledError } from '../lib/error-reporting';
import { nowMs } from '../lib/clock';
import {
  buildRecordSessionWorkoutInput,
  captureWorkoutRunClimbs,
  isServerSessionId,
  type RecordSessionWorkoutInput,
} from '../lib/session-workout-plan';
import { addWorkoutRunClimbs, getWorkoutRunState, nextWorkoutRunRevision } from '../lib/workout-run-store';
import { drainMutationQueue } from './offline-sync-adapter';
import { notifyOutboxChanged } from './outbox-store';
import { localWriteRetryOptions } from './local-write-telemetry';

/** The outbox table name the drainer routes to `recordSessionWorkout`. */
export const SESSION_WORKOUTS_OUTBOX_TABLE = 'session_workouts';

/** One write per session and revision: a replay of the same write keeps its key. */
export function sessionWorkoutIdempotencyKey(sessionId: string, revision: number): string {
  return `session_workout:${sessionId}:${revision}`;
}

/** Why a write was not queued, for tests and the dev log. */
export type SessionWorkoutWriteOutcome = 'queued' | 'sent' | 'skipped' | 'failed';

export type SessionWorkoutWriteOptions = {
  queryClient: QueryClient;
  /**
   * The live queue, when the caller has it. Fills in climbs the run record
   * never captured (a run an older bundle rewrote), for items still queued.
   */
  queueItems?: readonly ClimbQueueItem[];
};

const offlineSyncFetch: GraphQLFetch = (query, variables) => getOfflineSyncHttpClient().request(query, variables);

/**
 * Screenshot captures replay recorded responses, and a write nobody recorded
 * fails the capture; the captured flows never need the server's copy either.
 */
function isScreenshotCapture(): boolean {
  return process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
}

/** Without the offline database (flag off, web without the engine): straight to the server, best effort. */
async function sendDirectly(input: RecordSessionWorkoutInput): Promise<SessionWorkoutWriteOutcome> {
  const mutation: PendingMutation = {
    id: 0,
    table_name: SESSION_WORKOUTS_OUTBOX_TABLE,
    operation: 'create',
    payload: JSON.stringify(input),
    idempotency_key: sessionWorkoutIdempotencyKey(input.sessionId, input.revision),
    created_at: '',
    retry_count: 0,
    max_retries: 0,
    last_error: null,
    status: 'pending',
  };
  try {
    await processMutation(mutation, offlineSyncFetch);
    return 'sent';
  } catch (error) {
    reportHandledError(error, { tags: { source: 'session-workout', kind: 'direct-send' } });
    return 'failed';
  }
}

/**
 * Queue the run for `sessionId` at its next revision. Does nothing for a
 * session id the server never minted (stories, fakes, daily cards), in a
 * screenshot capture, or when the store holds no run for the session. Never
 * throws: losing a write costs the session screens their workout, never the
 * climb.
 */
export async function enqueueSessionWorkoutWrite(
  sessionId: string | null | undefined,
  { queryClient, queueItems }: SessionWorkoutWriteOptions,
): Promise<SessionWorkoutWriteOutcome> {
  if (!isServerSessionId(sessionId) || isScreenshotCapture()) return 'skipped';
  const record = getWorkoutRunState();
  if (record?.sessionId !== sessionId) return 'skipped';
  if (queueItems && queueItems.length > 0) {
    const runItems = new Set(record.run.stages.flatMap((stage) => stage.itemUuids));
    addWorkoutRunClimbs(
      sessionId,
      captureWorkoutRunClimbs(queueItems.filter((queueItem) => runItems.has(queueItem.uuid))),
    );
  }
  const revision = nextWorkoutRunRevision(sessionId, nowMs());
  const current = getWorkoutRunState();
  if (revision === null || !current) return 'skipped';
  const input = buildRecordSessionWorkoutInput(current, revision);
  if (!input) return 'skipped';

  const db = getDatabaseHandle();
  if (!db) return sendDirectly(input);
  try {
    await runLocalWriteWithRetry(
      async (attempt) => {
        await db.withExclusiveTransactionAsync(async (txn) => {
          await beginImmediateWrite(
            txn,
            attempt === 1 ? OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS : OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
          );
          // Both statements are safe to re-run: a retry after a COMMIT that
          // landed deletes nothing new and finds its own key already queued.
          await removePendingSessionWorkouts(txn, sessionId);
          await enqueue(
            txn,
            SESSION_WORKOUTS_OUTBOX_TABLE,
            'create',
            input,
            sessionWorkoutIdempotencyKey(sessionId, revision),
          );
        });
      },
      localWriteRetryOptions(SESSION_WORKOUTS_OUTBOX_TABLE, 'create'),
    );
  } catch (error) {
    reportHandledError(error, { tags: { source: 'session-workout', kind: 'enqueue' } });
    return 'failed';
  }
  notifyOutboxChanged();
  drainMutationQueue(db, queryClient, offlineSyncFetch).catch((error: unknown) => {
    if (__DEV__) console.warn('[session-workout] drain failed after queuing the workout:', error);
  });
  return 'queued';
}
