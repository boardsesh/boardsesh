import { roomManager, VersionConflictError } from '../../../services/room-manager';
import type { QueueState } from '../../../services/room-manager/types';
import { logger } from '../../../utils/logger';
import { MAX_RETRIES } from './types';

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
 * Not for `setQueue`: its payload is entirely client-supplied, so there is
 * nothing to recompute and last-writer-wins is the mutation's actual contract.
 */
export async function withQueueVersionRetry<T>(
  operation: string,
  sessionId: string,
  runAttempt: (state: QueueState) => Promise<T>,
): Promise<T> {
  let lastConflict: VersionConflictError | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const state = await roomManager.getQueueState(sessionId);
    try {
      return await runAttempt(state);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) {
        throw error;
      }
      lastConflict = error;
    }
  }

  // Greppable: if this ever shows up in volume, the session is under genuine
  // concurrent-write pressure and MAX_RETRIES needs revisiting.
  logger.warn(
    `[queue-retry] ${operation} exhausted ${MAX_RETRIES} version-conflict retries for session ${sessionId} — ` +
      `concurrent queue mutations are contending (#3906)`,
  );
  // Always set by the loop above (it only falls through after a conflict), but
  // typed as optional — don't let a future MAX_RETRIES <= 0 throw `undefined`.
  throw lastConflict ?? new VersionConflictError(sessionId, -1);
}
