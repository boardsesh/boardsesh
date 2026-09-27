import { workerConfig, configureWorkerPools } from './config';
import { logger } from '../utils/logger';

async function main() {
  // This is a trusted-host CLI authenticated by OS access and the DB login.
  // No public enqueue endpoint or arbitrary queue/SQL argument exists; payloads
  // pass the family's own schema.
  if (process.env.WORKER_OPERATOR_ENABLED !== 'true') throw new Error('OPERATOR_DISABLED');
  const config = workerConfig();
  configureWorkerPools();
  const { parseOperatorArgs } = await import('./operator-args');
  const command = parseOperatorArgs(process.argv.slice(2), config.role);
  const { createDb, closePool } = await import('@boardsesh/db/client');
  const { eq } = await import('drizzle-orm');
  const { backgroundJobRuns } = await import('@boardsesh/db/schema');
  const { createJobQueueClient, assertQueuePrimary, assertWorkerPrivileges } =
    await import('../services/job-queue-client');
  const { enqueueBackgroundJob } = await import('./jobs');
  const database = createDb();
  const boss = createJobQueueClient({ connectionString: config.databaseUrl, poolSize: 1, owner: 'worker' });
  try {
    await boss.start();
    await assertQueuePrimary(boss.getDb());
    await assertWorkerPrivileges(boss.getDb());
    if (command.action === 'status' || command.action === 'replay') {
      const [run] = await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, command.runId));
      if (!run || run.role !== config.role) throw new Error('RUN_NOT_FOUND');
      if (command.action === 'status') {
        logger.info('[worker] run', {
          runId: run.id,
          family: run.family,
          status: run.status,
          attempt: run.attemptNumber,
          errorCode: run.errorCode,
        });
        return;
      }
      if (!['failed', 'cancelled'].includes(run.status)) throw new Error('RUN_NOT_REPLAYABLE');
      // Replay re-validates the stored payload against today's schema. A key
      // that only defaulted to the old run ID is left to default again.
      const accepted = await enqueueBackgroundJob(database, boss, {
        role: config.role,
        family: run.family,
        payload: run.payload,
        runId: command.newRunId,
        singletonKey: run.singletonKey && run.singletonKey !== run.id ? run.singletonKey : undefined,
      });
      logger.info('[worker] accepted', { ...accepted, family: run.family, role: config.role, replayOf: run.id });
      return;
    }
    const accepted =
      command.action === 'probe'
        ? await enqueueBackgroundJob(database, boss, {
            role: config.role,
            family: 'worker-probe',
            payload: {},
            runId: command.runId,
          })
        : await enqueueBackgroundJob(database, boss, {
            role: config.role,
            family: command.family,
            payload: command.payload,
            runId: command.runId,
          });
    logger.info('[worker] accepted', { ...accepted, role: config.role });
  } finally {
    await boss.stop({ graceful: true, close: true });
    await closePool();
  }
}

void main().catch(() => {
  logger.error('[worker] operator command failed', new Error('WORKER_OPERATOR_FAILED'));
  process.exit(1);
});
