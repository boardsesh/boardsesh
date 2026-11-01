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
  getLocalUserId,
  isMutationPending,
  supersedePendingSessionWorkouts,
  runLocalWriteWithRetry,
  type GraphQLFetch,
  type PendingMutation,
} from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { addErrorBreadcrumb, reportHandledError } from '../lib/error-reporting';
import { nowMs } from '../lib/clock';
import {
  buildSessionWorkoutContent,
  captureWorkoutRunClimbs,
  isServerSessionId,
  sessionWorkoutDigest,
  type RecordSessionWorkoutInput,
  type SessionWorkoutContent,
} from '../lib/session-workout-plan';
import {
  addWorkoutRunClimbs,
  getWorkoutRunState,
  nextWorkoutRunRevision,
  noteWorkoutRunSent,
  revisionAfter,
  type WorkoutRunRecord,
} from '../lib/workout-run-store';
import { drainMutationQueue, readSignedInUserIdOrNull } from './offline-sync-adapter';
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

/**
 * Why a write that should have gone out was dropped: the run has no climb the
 * server can store (`no-plan`), or no account to file it under (`no-owner`:
 * the token names nobody, or the outbox is stamped for someone else). Both
 * leave the session without its workout and used to leave no trace (#6903), so
 * they go on the Sentry trail. Low-cardinality on purpose: no ids.
 */
function noteSkippedWrite(reason: 'no-plan' | 'no-owner', path: 'live' | 'ended'): void {
  addErrorBreadcrumb({
    category: 'session-workout',
    message: `write skipped: ${reason}`,
    level: 'warning',
    data: { path },
  });
}

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
 * Queue (or, with no offline database, send) one write for `ownerUserId`.
 * Nothing is queued unless the outbox is stamped for that same account: a
 * write that lost a lock to sign-out's wipe and retried after it would
 * otherwise land in the next account's outbox (the drainer refuses an
 * unstamped one anyway).
 */
async function queueWrite(
  input: RecordSessionWorkoutInput,
  queryClient: QueryClient,
  ownerUserId: string | null,
  path: 'live' | 'ended',
): Promise<SessionWorkoutWriteOutcome> {
  if (!ownerUserId) {
    noteSkippedWrite('no-owner', path);
    return 'skipped';
  }
  const db = getDatabaseHandle();
  if (!db) return sendDirectly(input);
  const { sessionId, revision } = input;
  let queued = false;
  let ownerMismatch = false;
  try {
    await runLocalWriteWithRetry(
      async (attempt) => {
        queued = false;
        ownerMismatch = false;
        await db.withExclusiveTransactionAsync(async (txn) => {
          await beginImmediateWrite(
            txn,
            attempt === 1 ? OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS : OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
          );
          if ((await getLocalUserId(txn)) !== ownerUserId) {
            ownerMismatch = true;
            return;
          }
          // Safe to re-run: a retry after a COMMIT that landed finds its own
          // row at this revision and queues nothing more. A write that lost a
          // race to a newer one leaves that one alone and queues nothing.
          const { newerPending } = await supersedePendingSessionWorkouts(txn, sessionId, revision);
          if (newerPending) return;
          await enqueue(
            txn,
            SESSION_WORKOUTS_OUTBOX_TABLE,
            'create',
            input,
            sessionWorkoutIdempotencyKey(sessionId, revision),
          );
          queued = true;
        });
      },
      localWriteRetryOptions(SESSION_WORKOUTS_OUTBOX_TABLE, 'create'),
    );
  } catch (error) {
    reportHandledError(error, { tags: { source: 'session-workout', kind: 'enqueue' } });
    return 'failed';
  }
  if (ownerMismatch) noteSkippedWrite('no-owner', path);
  if (!queued) return 'skipped';
  notifyOutboxChanged();
  drainMutationQueue(db, queryClient, offlineSyncFetch).catch((error: unknown) => {
    if (__DEV__) console.warn('[session-workout] drain failed after queuing the workout:', error);
  });
  return 'queued';
}

/**
 * Whether the last copy (`revision`, holding `sentDigest`) already covers
 * `digest`: the same content, and the copy is still waiting in the outbox (it
 * will be sent) or was sent straight to the server. A copy that left the outbox
 * may have been delivered or dead-lettered, and the outbox cannot tell which,
 * so the write goes out again: a repeat of a delivered copy is one request the
 * server writes over itself, a lost one would leave it on an older copy.
 */
async function lastCopyCovers(
  record: Pick<WorkoutRunRecord, 'sessionId' | 'revision' | 'sentDigest'>,
  digest: string,
): Promise<boolean> {
  if (record.sentDigest !== digest || record.revision === undefined) return false;
  const db = getDatabaseHandle();
  if (!db) return true;
  try {
    return await isMutationPending(db, sessionWorkoutIdempotencyKey(record.sessionId, record.revision));
  } catch {
    return false;
  }
}

/** What a write for `sessionId`'s run would hold right now, from the store. */
function currentContent(
  sessionId: string,
): { record: WorkoutRunRecord; content: SessionWorkoutContent; digest: string } | null {
  const record = getWorkoutRunState();
  if (record?.sessionId !== sessionId) return null;
  const content = buildSessionWorkoutContent(record);
  return content ? { record, content, digest: sessionWorkoutDigest(content) } : null;
}

/**
 * Queue the run for `sessionId` at its next revision. Does nothing for a
 * session id the server never minted (stories, fakes, daily cards), in a
 * screenshot capture, when the store holds no run for the session, or when the
 * last copy still waiting already holds everything. Never throws: losing a
 * write costs the session screens their workout, never the climb.
 *
 * `queueItems` (the live queue) fills in climbs the run never captured and
 * brings each climb's mirror up to date.
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
  const ownerUserId = await readSignedInUserIdOrNull();
  const before = currentContent(sessionId);
  if (!before) {
    noteSkippedWrite('no-plan', 'live');
    return 'skipped';
  }
  if (await lastCopyCovers(before.record, before.digest)) {
    // Covered, unless the run moved on while the outbox was read.
    const after = currentContent(sessionId);
    if (!after || after.digest === before.digest) return 'skipped';
  }
  // Built and numbered with no await between them, so of two overlapping
  // writes the one numbered higher always holds the newer run.
  const latest = currentContent(sessionId);
  if (!latest) return 'skipped';
  const { content, digest } = latest;
  const revision = nextWorkoutRunRevision(sessionId, nowMs());
  if (revision === null) return 'skipped';
  const outcome = await queueWrite({ ...content, revision }, queryClient, ownerUserId, 'live');
  if (outcome === 'queued' || outcome === 'sent') noteWorkoutRunSent(sessionId, revision, digest);
  return outcome;
}

/**
 * The last copy of a run whose session is over (#6903), from the record the
 * store let go of: the session ended on another phone, the climber dropped out
 * quietly or was removed, or the app was killed and came back to an ended
 * session. Only a local End reaches `enqueueSessionWorkoutWrite` from
 * `beforeEnd`; every way out reaches this. Skipped while the End's copy is
 * still waiting with the same content; sent again when that copy left the
 * outbox (it may have dead-lettered).
 *
 * `ownerUserId` is the account the record was cleared under; nothing is queued
 * into an outbox stamped for anyone else.
 */
export async function enqueueEndedSessionWorkout(
  record: WorkoutRunRecord,
  { queryClient, ownerUserId }: Pick<SessionWorkoutWriteOptions, 'queryClient'> & { ownerUserId: string | null },
): Promise<SessionWorkoutWriteOutcome> {
  if (!isServerSessionId(record.sessionId) || isScreenshotCapture()) return 'skipped';
  const content = buildSessionWorkoutContent(record);
  if (!content) {
    noteSkippedWrite('no-plan', 'ended');
    return 'skipped';
  }
  if (await lastCopyCovers(record, sessionWorkoutDigest(content))) return 'skipped';
  return queueWrite(
    { ...content, revision: revisionAfter(record.revision, nowMs()) },
    queryClient,
    ownerUserId,
    'ended',
  );
}
