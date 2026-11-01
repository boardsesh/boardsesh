import {
  countPendingSessionWrites,
  hasPendingTickForClimb,
  hasPendingTicksForSession,
  type PendingSessionWrites,
} from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { reportHandledError } from '../lib/error-reporting';

/**
 * Whether this phone still has a send on `climbUuid` waiting in the outbox
 * (#5960). "Delete climb" refuses while it does: the server counts only the
 * ticks it has, so the delete would win and the queued send would dead-letter.
 *
 * No database (signed out, web without the engine) means no outbox, so false.
 * A failed read is reported and answers false: the server still refuses a climb
 * with any tick it already has.
 */
export async function hasQueuedTickForClimb(climbUuid: string): Promise<boolean> {
  const db = getDatabaseHandle();
  if (!db) return false;
  try {
    return await hasPendingTickForClimb(db, climbUuid);
  } catch (error) {
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'pending-tick-check' } });
    return false;
  }
}

/**
 * Whether this phone still has a tick logged in `sessionId` waiting in the
 * outbox (#6903). Ending a session reads it twice: before END_SESSION, to wait
 * for those sends (`waitForSessionTicksToSync`), and after, to hold back the
 * store-review prompt while the summary is still short of them.
 *
 * Same answers as `hasQueuedTickForClimb`: no database means no outbox, and a
 * failed read is reported and answers false.
 */
export async function hasQueuedTicksForSession(sessionId: string): Promise<boolean> {
  const db = getDatabaseHandle();
  if (!db) return false;
  try {
    return await hasPendingTicksForSession(db, sessionId);
  } catch (error) {
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'pending-session-ticks-check' } });
    return false;
  }
}

const NO_PENDING_WRITES: PendingSessionWrites = { ticks: 0, workouts: 0 };

/**
 * What this phone still has to send for `sessionId` (#6903): the summary's
 * "Still saving N ticks", and whether its workout is newer than the server's.
 * Same answers as above: no database, or a failed read (reported), is nothing.
 */
export async function readPendingSessionWrites(sessionId: string): Promise<PendingSessionWrites> {
  const db = getDatabaseHandle();
  if (!db) return NO_PENDING_WRITES;
  try {
    return await countPendingSessionWrites(db, sessionId);
  } catch (error) {
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'pending-session-writes-check' } });
    return NO_PENDING_WRITES;
  }
}
