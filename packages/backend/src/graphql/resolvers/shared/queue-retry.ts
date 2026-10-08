import { roomManager, VersionConflictError } from '../../../services/room-manager';
import type { QueueState } from '../../../services/room-manager/types';
import { logger } from '../../../utils/logger';
// A dozen simultaneous party writes can each lose a CAS round. Keep the
// retry budget bounded, with jitter so they do not repeatedly collide together.
const MAX_QUEUE_VERSION_RETRIES = 16;

/**
 * Run a queue mutation as read-compute-compare-and-swap, retrying on a version
 * conflict with freshly read state each time (issue #3906).
 *
 * Every mutation that derives its new queue from the current queue has to do
 * this. Without it, two overlapping mutations both read the same state and the
 * second write silently discards the first one's change — a climb a party
 * member just added simply disappears, and because the server's own state stays
 * internally consistent the client hash watchdog never sees any drift.
 *
 * `runAttempt` must recompute from the `state` it is handed rather than closing
 * over an earlier snapshot, otherwise the retry replays the same stale write.
 * It must pass `state.version` down as the `expectedVersion` so the CAS has
 * something to compare.
 *
 * `setQueue` uses this only on its merge path (issue #3933), where the caller
 * supplied the baseline sequence it composed its payload against and the
 * resolver folds peer adds back in from the replay buffer — that IS a
 * recompute against current state. A `setQueue` with no baseline still writes
 * unversioned: nothing to recompute, last-writer-wins is the contract. It also
 * catches the throw below and drops to that unversioned write, so a contended
 * session can never turn a wholesale replace into a user-facing error.
 */
export async function withQueueVersionRetry<T>(
  operation: string,
  sessionId: string,
  runAttempt: (state: QueueState) => Promise<T>,
): Promise<T> {
  let lastConflict: VersionConflictError | undefined;

  for (let attempt = 0; attempt < MAX_QUEUE_VERSION_RETRIES; attempt++) {
    const state = await roomManager.getQueueState(sessionId);
    try {
      return await runAttempt(state);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) {
        throw error;
      }
      lastConflict = error;
      await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 20)));
    }
  }

  // Greppable: if this ever shows up in volume, the session is under genuine
  // concurrent-write pressure and MAX_QUEUE_VERSION_RETRIES needs revisiting.
  logger.warn(
    `[queue-retry] ${operation} exhausted ${MAX_QUEUE_VERSION_RETRIES} version-conflict retries for session ${sessionId} — ` +
      `concurrent queue mutations are contending (#3906)`,
  );
  // Always set by the loop above (it only falls through after a conflict), but
  // typed as optional — don't let a future MAX_QUEUE_VERSION_RETRIES <= 0 throw `undefined`.
  throw lastConflict ?? new VersionConflictError(sessionId, -1);
}
