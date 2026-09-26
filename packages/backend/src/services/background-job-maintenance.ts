import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import { BACKGROUND_JOB_RECONCILE_QUEUE } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { reconcileBackgroundJobRun } from '@boardsesh/db/queries';
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
  };
}

export async function startBackgroundJobMaintenance(boss: PgBoss, database: DbInstance): Promise<void> {
  await boss.schedule(BACKGROUND_JOB_RECONCILE_QUEUE, '* * * * *', {}, { tz: 'UTC' });
  const reconcile = backgroundJobReconciler(database);
  await boss.work(
    BACKGROUND_JOB_RECONCILE_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: MAINTENANCE_POLLING_INTERVAL_SECONDS },
    async () => {
      await reconcile();
    },
  );
}
