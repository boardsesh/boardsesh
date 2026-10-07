import { hasPendingTickForClimb } from '@boardsesh/offline-sync';
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
