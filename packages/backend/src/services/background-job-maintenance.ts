import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import { BACKGROUND_JOB_RECONCILE_QUEUE } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { clearFinishedProviderSyncRuns, reconcileBackgroundJobRun } from '@boardsesh/db/queries';
import { deleteExpiredCommandClaims } from '../auth/current-store/command-context';
import { purgeRetiredEmailKeys } from '../auth/current-store/email-reservations';
import { logger } from '../utils/logger';
import { MAINTENANCE_POLLING_INTERVAL_SECONDS } from './job-queue-client';

/** Backend-owned, bounded and fair even while every homelab consumer is offline. */
export function backgroundJobReconciler(database: DbInstance) {
  let cursor: string | undefined;
  return async () => {
    const candidates = await database
      .select({ id: backgroundJobRuns.id })
      .from(backgroundJobRuns)
      .where(
        and(
          inArray(backgroundJobRuns.status, ['queued', 'running', 'retrying']),
          cursor ? gt(backgroundJobRuns.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(backgroundJobRuns.id))
      .limit(100);
    for (const candidate of candidates) await reconcileBackgroundJobRun(database, candidate.id);
    cursor = candidates.length === 100 ? candidates[candidates.length - 1].id : undefined;
    // Keep diagnostic history for 30 days; never purge active or retryable work.
    const expired = await database
      .select({ id: backgroundJobRuns.id })
      .from(backgroundJobRuns)
      .where(
        and(
          inArray(backgroundJobRuns.status, ['succeeded', 'failed', 'cancelled']),
          lt(backgroundJobRuns.finishedAt, new Date(Date.now() - 30 * 86400_000)),
        ),
      )
      .orderBy(asc(backgroundJobRuns.finishedAt))
      .limit(100);
    for (const run of expired)
      await database
        .delete(backgroundJobRuns)
        .where(
          and(
            eq(backgroundJobRuns.id, run.id),
            inArray(backgroundJobRuns.status, ['succeeded', 'failed', 'cancelled']),
          ),
        );
    // Provider sync control rows still pointing at a finished or purged run: a
    // worker that died mid-sync leaves its lease and pending run behind, and
    // "Sync now" would otherwise coalesce onto a dead run. Bounded like the
    // two steps above.
    await clearFinishedProviderSyncRuns(database, 100);
  };
}

/**
 * Expired staged-auth records, whatever the mode: rows written while a staged
 * mode was on must still go after it is switched off, and with none it is two
 * empty reads. Replay records (`ba03-web-auth:`) go once expired; a deleted
 * address's digest goes 90 days after the deletion.
 */
export async function clearExpiredAuthRecords(database: DbInstance): Promise<void> {
  // SQL failures can carry bound values. Keep fixed categories; the next minute retries.
  try {
    // A prefix LIKE cannot use the text primary key under en_US collation, so this
    // reads all of verificationTokens each minute: 32 kB in production on 2026-11-11.
    await deleteExpiredCommandClaims(database);
  } catch {
    logger.warn('Current-store command claim cleanup unavailable');
  }
  try {
    await purgeRetiredEmailKeys(database);
  } catch {
    logger.warn('Deleted-address digest cleanup unavailable');
  }
}

export async function startBackgroundJobMaintenance(boss: PgBoss, database: DbInstance): Promise<void> {
  await boss.schedule(BACKGROUND_JOB_RECONCILE_QUEUE, '* * * * *', {}, { tz: 'UTC' });
  const reconcile = backgroundJobReconciler(database);
  await boss.work(
    BACKGROUND_JOB_RECONCILE_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: MAINTENANCE_POLLING_INTERVAL_SECONDS },
    async () => {
      await reconcile();
      await clearExpiredAuthRecords(database);
    },
  );
}
