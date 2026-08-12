// Telemetry for offline writes that are lost somewhere other than the drain
// loop. The drainer's own dead-letter seam (offline-sync-adapter) covers writes
// the server permanently rejects; these three cover the losses it structurally
// cannot see:
//
//   1. Backlog at launch — per-mutation events only count from the day they
//      ship, so a queue that piled up earlier is invisible without a gauge.
//   2. Sign-out — clearUserData DELETEs pending_mutations wholesale, dead
//      letters included, with no drain attempt for them (the pre-sign-out drain
//      gates on getPendingCount, which filters status = 'pending').
//   3. Suppressed enqueue — `INSERT OR IGNORE` against a deterministic
//      idempotency key silently drops a repeat favorite/follow whenever the
//      existing row is already a dead letter. The drop happens at enqueue time,
//      so no drain and no dead-letter event ever mentions it.

import { getOutboxSummary, queueTimestampAgeDays, type OutboxSummary, type SqlExecutor } from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';
import { reportHandledError } from '../lib/error-reporting';

type OutboxGaugeProps = {
  pendingCount: number;
  deadLetterCount: number;
  oldestPendingAgeDays: number | null;
  oldestDeadLetterAgeDays: number | null;
};

function toGaugeProps(summary: OutboxSummary): OutboxGaugeProps {
  return {
    pendingCount: summary.pendingCount,
    deadLetterCount: summary.deadLetterCount,
    oldestPendingAgeDays: queueTimestampAgeDays(summary.oldestPendingAt),
    oldestDeadLetterAgeDays: queueTimestampAgeDays(summary.oldestDeadLetterAt),
  };
}

// Once per JS runtime, not once per effect: the bridge's sync effect re-runs on
// a flag flip, an auth flip, or a snapshotSource change, and a gauge that fired
// on each of those would read as several backlogs rather than one.
let hasReportedOutboxBacklog = false;

/**
 * Report the outbox backlog this launch inherited, at most once per runtime and
 * only when something is actually queued. Never throws: a failed read must not
 * take the sync bridge down with it.
 */
export async function reportOutboxBacklogOnce(db: SqlExecutor): Promise<void> {
  if (hasReportedOutboxBacklog) return;
  hasReportedOutboxBacklog = true;
  try {
    const summary = await getOutboxSummary(db);
    if (summary.pendingCount === 0 && summary.deadLetterCount === 0) return;
    track(SHARED_EVENTS.OfflineOutboxBacklogDetected, toGaugeProps(summary));
  } catch (error) {
    if (__DEV__) console.warn('[OutboxTelemetry] backlog gauge failed:', error);
  }
}

/**
 * Report what sign-out is about to delete. MUST be awaited before
 * resetAnalytics(), or the event lands on an anonymous distinct_id and can no
 * longer be joined to the account that lost the writes. Never throws, so a
 * wedged database can't block sign-out.
 */
export async function reportOutboxDiscardedOnSignOut(db: SqlExecutor): Promise<void> {
  try {
    const summary = await getOutboxSummary(db);
    if (summary.pendingCount === 0 && summary.deadLetterCount === 0) return;
    track(SHARED_EVENTS.OfflineOutboxDiscardedOnSignOut, toGaugeProps(summary));
  } catch (error) {
    if (__DEV__) console.warn('[OutboxTelemetry] sign-out discard gauge failed:', error);
  }
}

/**
 * Report a repeat write that `INSERT OR IGNORE` swallowed because a
 * dead-lettered row already holds its idempotency key.
 *
 * Only the dead-letter case is reported. A suppression against a `pending` row
 * is correct dedup — a double-tapped favorite while offline — and reporting it
 * would bury the signal under the common case.
 */
export function reportEnqueueSuppressed(
  tableName: string,
  operation: 'create' | 'delete',
  existingStatus: string | null,
): void {
  if (existingStatus !== 'dead_letter') return;
  try {
    reportHandledError(new Error(`Offline ${tableName} ${operation} suppressed by a dead-lettered queue row`), {
      tags: { source: 'offline-sync', kind: 'mutation-enqueue-suppressed' },
      extra: { tableName, operation, existingStatus },
    });
    track(SHARED_EVENTS.OfflineMutationEnqueueSuppressed, { tableName, operation, existingStatus });
  } catch (error) {
    if (__DEV__) console.warn('[OutboxTelemetry] suppressed-enqueue report failed:', error);
  }
}

export function __resetOutboxTelemetryForTests(): void {
  hasReportedOutboxBacklog = false;
}
