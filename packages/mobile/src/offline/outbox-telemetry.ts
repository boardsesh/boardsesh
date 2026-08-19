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
//
// The launch pass also HEALS one specific kind of dead letter — see
// `reviveLockedDeadLetters` (#4331).

import {
  getDeadLetters,
  getOutboxSummary,
  isDatabaseLockedError,
  queueTimestampAgeDays,
  retryDeadLetter,
  type OutboxSummary,
  type SqlExecutor,
} from '@boardsesh/offline-sync';
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
 * A ceiling on the launch sweep, not a real limit: production devices carry
 * single-digit dead letters. It only stops a pathologically large outbox from
 * turning app launch into hundreds of UPDATEs; anything past it is picked up by
 * the next launch.
 */
const MAX_DEAD_LETTERS_REVIVED_PER_LAUNCH = 50;

/**
 * Put back the dead letters a lost local write lock manufactured (#4331).
 *
 * Until this release, a `database is locked` thrown by the drainer's outbox
 * DELETE — the only local write in that try block, and one that runs AFTER the
 * server has accepted the mutation — was classified non-retryable and
 * force-dead-lettered the row. Every `Offline Mutation Dead Lettered` event in a
 * 45-day window was one of these, with no server status attached, and the row
 * then held its deterministic idempotency key until the user found More → Sync
 * issues → Retry. Devices are still carrying rows up to a month old.
 *
 * So this re-sends ONLY writes the server never rejected: the filter is the same
 * `isDatabaseLockedError` predicate the drainer and the write ladder use, read
 * off the row's stored `last_error`. A dead letter from a 4xx, a validation
 * failure, or a broken database is left exactly where it is. Every handled
 * mutation is idempotent server-side, so a revived write that did land is a
 * no-op.
 */
async function reviveLockedDeadLetters(db: SqlExecutor): Promise<number> {
  const deadLetters = await getDeadLetters(db);
  let revived = 0;
  for (const row of deadLetters) {
    if (revived >= MAX_DEAD_LETTERS_REVIVED_PER_LAUNCH) break;
    // `last_error` is the raw driver message markDeadLetter stored; the
    // predicate takes a string as readily as an Error.
    if (!isDatabaseLockedError(row.last_error)) continue;
    try {
      await retryDeadLetter(db, row.id);
      revived += 1;
    } catch (error) {
      // Per row, not per sweep: the failure this exists to recover from is a
      // held write lock, and the sweep runs once per runtime — letting one
      // contended UPDATE abort the loop would strand every row behind it until
      // the next launch.
      if (__DEV__) console.warn('[OutboxTelemetry] could not revive dead letter', row.id, error);
    }
  }
  return revived;
}

/**
 * Report the outbox backlog this launch inherited AND put back the dead letters
 * a local write lock manufactured, at most once per runtime and only when
 * something is actually queued. Never throws: neither a failed read nor a failed
 * revive may take the sync bridge down with it.
 *
 * The counts on the event are read BEFORE the sweep, so they describe what the
 * launch inherited; `deadLettersRevived` says how many of them went back into
 * the queue. Revived rows are left for the scheduler's next drain — the same
 * trigger that drains anything else queued at launch.
 */
export async function recoverAndReportOutboxOnce(db: SqlExecutor): Promise<void> {
  if (hasReportedOutboxBacklog) return;
  hasReportedOutboxBacklog = true;
  try {
    const summary = await getOutboxSummary(db);
    if (summary.pendingCount === 0 && summary.deadLetterCount === 0) return;
    const deadLettersRevived = summary.deadLetterCount === 0 ? 0 : await reviveLockedDeadLetters(db);
    track(SHARED_EVENTS.OfflineOutboxBacklogDetected, { ...toGaugeProps(summary), deadLettersRevived });
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
 * Report a repeat favorite/follow that reclaimed the idempotency key its
 * dead-lettered predecessor was holding (#4331). A recovery, not a defect, so it
 * gets the PostHog event and no Sentry report — the user's write is on its way.
 */
export function reportEnqueueRevived(tableName: string, operation: 'create' | 'delete'): void {
  try {
    track(SHARED_EVENTS.OfflineMutationRevived, { tableName, operation });
  } catch (error) {
    if (__DEV__) console.warn('[OutboxTelemetry] revived-enqueue report failed:', error);
  }
}

/**
 * Report a repeat write that `INSERT OR IGNORE` swallowed because a
 * dead-lettered row already holds its idempotency key.
 *
 * Only the dead-letter case is reported. A suppression against a `pending` row
 * is correct dedup — a double-tapped favorite while offline — and reporting it
 * would bury the signal under the common case.
 *
 * Since #4331 the favorite/follow call sites revive that row instead, so this
 * should no longer fire from them at all: it stays wired as the alarm for a
 * revive that didn't take (and for any deterministic-key call site added later
 * that forgets to opt in).
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
