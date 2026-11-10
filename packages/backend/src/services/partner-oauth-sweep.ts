/**
 * Runs the partner OAuth retention sweep (`auth/partner/retention.ts`,
 * docs/integration-platform.md "Retention sweep").
 *
 * - **Hourly, on the job queue.** `PARTNER_OAUTH_SWEEP_QUEUE` is created by the
 *   migrator with the `exclusive` policy, so one run is queued or running across
 *   every replica.
 * - **Whatever the partner mode.** Rows written while partner OAuth was on must
 *   still go after it is switched off. With the tables empty, as they are until
 *   the first connection, a run is six index probes and no write.
 * - **Never Better Auth.** The sweep is plain SQL on the partner tables, so
 *   registering it loads nothing the mode switch keeps unloaded.
 */
import type { PgBoss } from 'pg-boss';
import { PARTNER_OAUTH_SWEEP_QUEUE } from '@boardsesh/db/job-queue-schema';
import { sweepPartnerOAuth } from '../auth/partner/retention';
import { db } from '../db/client';
import { logger } from '../utils/logger';

/** Every hour at :34, away from the :07, :13, :17, :22, :23, :37 and :41 jobs. */
export const PARTNER_OAUTH_SWEEP_CRON = '34 * * * *';

/** The body of the sweep job. Throws on an unexpected database error so pg-boss retries. */
export async function runPartnerOAuthSweep(): Promise<void> {
  const result = await sweepPartnerOAuth(db);
  const deletedRows = Object.values(result.counts).reduce((total, count) => total + count, 0);
  // Counts only: never ids, hashes or anything else from a row.
  if (result.busySteps.length > 0) {
    logger.warn('[PartnerOAuthSweep] Stopped steps early on a busy database', {
      busySteps: result.busySteps,
      ...result.counts,
    });
  } else if (deletedRows > 0 || !result.complete) {
    logger.info('[PartnerOAuthSweep] Swept', { complete: result.complete, ...result.counts });
  }
}

export async function startPartnerOAuthSweep(boss: PgBoss): Promise<void> {
  await boss.schedule(PARTNER_OAUTH_SWEEP_QUEUE, PARTNER_OAUTH_SWEEP_CRON, null, { tz: 'UTC' });
  await boss.work(PARTNER_OAUTH_SWEEP_QUEUE, async () => {
    await runPartnerOAuthSweep();
  });
}
