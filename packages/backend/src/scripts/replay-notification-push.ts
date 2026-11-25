/** Bounded operator recovery. Dry run by default; uses normal delivery validation. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asc, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { closePool, getConnectionConfig } from '@boardsesh/db/client';
import { notificationDeliveries } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { assertQueuePrimary, createJobQueueClient } from '../services/job-queue-client';
import { parsePushReplayArgs } from '../services/notification-push-replay-options';
import { deliverSprayNotification } from '../services/spray-detection-notifications';
import { logger } from '../utils/logger';

export async function replayNotificationPushDeliveries(limit: number, boss: PgBoss | null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('PUSH_REPLAY_LIMIT_MUST_BE_1_TO_200');
  if (boss) await assertQueuePrimary(boss.getDb());
  const candidates = await db
    .select({ id: notificationDeliveries.id, status: notificationDeliveries.status })
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.status, ['pending', 'receipt']))
    .orderBy(asc(notificationDeliveries.updatedAt), asc(notificationDeliveries.id))
    .limit(limit);
  const summary = {
    selected: candidates.length,
    attempted: 0,
    deferred: 0,
    retryableErrors: 0,
    statuses: { pending: 0, receipt: 0, done: 0, skipped: 0, missing: 0 },
  };
  for (const candidate of candidates) {
    if (!boss) {
      summary.statuses[candidate.status]++;
      continue;
    }
    summary.attempted++;
    try {
      // The existing driver serializes concurrent attempts, rechecks source and
      // device access, skips terminal rows, and atomically schedules receipts.
      await deliverSprayNotification(boss, candidate.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'PUSH_RECEIPT_NOT_READY') summary.deferred++;
      else if (
        error instanceof Error &&
        (error.message === 'EXPO_PUSH_RETRY' || error.message === 'EXPO_PUSH_HTTP_FAILED')
      )
        summary.retryableErrors++;
      else throw error;
    }
    const [after] = await db
      .select({ status: notificationDeliveries.status })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, candidate.id));
    summary.statuses[after?.status ?? 'missing']++;
  }
  return summary;
}

async function main(argv: readonly string[]) {
  const options = parsePushReplayArgs(argv);
  let boss: PgBoss | null = null;
  try {
    if (options.apply) {
      boss = createJobQueueClient({
        connectionString: getConnectionConfig().connectionString,
        poolSize: 1,
        owner: 'worker',
      });
      await boss.start();
    }
    const summary = await replayNotificationPushDeliveries(options.limit, boss);
    process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', ...summary })}\n`);
  } finally {
    await boss?.stop({ graceful: false, close: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .catch(() => {
      // Query errors contain bound tokens and identities. Never print the raw error.
      logger.error('Notification push replay failed; check arguments, database, and safe delivery diagnostics');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
