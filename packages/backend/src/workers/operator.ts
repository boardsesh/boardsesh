import { randomUUID } from 'node:crypto';
import { workerConfig, configureWorkerPools } from './config';
import { logger } from '../utils/logger';

async function main() {
  // This is a trusted-host CLI authenticated by OS access and the DB login.
  // No public enqueue endpoint or arbitrary queue/payload/SQL argument exists.
  if (process.env.WORKER_OPERATOR_ENABLED !== 'true') throw new Error('OPERATOR_DISABLED');
  const config = workerConfig();
  configureWorkerPools();
  const { createDb, closePool } = await import('@boardsesh/db/client');
  const { eq } = await import('drizzle-orm');
  const { backgroundJobRuns } = await import('@boardsesh/db/schema');
  const { createJobQueueClient, assertQueuePrimary } = await import('../services/job-queue-client');
  const { enqueueWorkerProbe, requireRunId } = await import('./jobs');
  const database = createDb();
  const boss = createJobQueueClient({ connectionString: config.databaseUrl, poolSize: 1, owner: 'worker' });
  try {
    await boss.start();
    await assertQueuePrimary(boss.getDb());
    const [action, id, retryId, ...extra] = process.argv.slice(2);
    if (extra.length || !['enqueue', 'replay', 'status'].includes(action))
      throw new Error('INVALID_OPERATOR_ARGUMENTS');
    let runId: string;
    if (action === 'status' || action === 'replay') {
      const [run] = await database
        .select()
        .from(backgroundJobRuns)
        .where(eq(backgroundJobRuns.id, requireRunId(id)));
      if (!run || run.role !== config.role) throw new Error('RUN_NOT_FOUND');
      if (action === 'status') {
        if (retryId) throw new Error('INVALID_OPERATOR_ARGUMENTS');
        logger.info('[worker] run', {
          runId: run.id,
          status: run.status,
          attempt: run.attemptNumber,
          errorCode: run.errorCode,
        });
        return;
      }
      if (!['failed', 'cancelled'].includes(run.status)) throw new Error('RUN_NOT_REPLAYABLE');
      runId = await enqueueWorkerProbe(database, boss, config.role, retryId ? requireRunId(retryId) : randomUUID());
    } else {
      if (retryId) throw new Error('INVALID_OPERATOR_ARGUMENTS');
      runId = await enqueueWorkerProbe(database, boss, config.role, id ? requireRunId(id) : randomUUID());
    }
    logger.info('[worker] accepted', { runId, role: config.role });
  } finally {
    await boss.stop({ graceful: true, close: true });
    await closePool();
  }
}

void main().catch(() => {
  logger.error('[worker] operator command failed', new Error('WORKER_OPERATOR_FAILED'));
  process.exit(1);
});
