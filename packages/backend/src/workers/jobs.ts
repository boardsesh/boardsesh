import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { PgBoss, JobWithMetadata } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import {
  BACKGROUND_JOB_QUEUES,
  BACKGROUND_PROBE_JOB_OPTIONS,
  type BackgroundWorkerRole,
} from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import {
  claimBackgroundJobRun,
  settleBackgroundJobRun,
  withBackgroundJobAttempt,
  type BackgroundJobTransaction,
} from '@boardsesh/db/queries';
import { enqueueOn } from '../services/job-queue';

function requireSettlement(result: unknown): void {
  // pg-boss 12.33 returns affected at runtime but publishes an empty CommandResponse type.
  if (!result || typeof result !== 'object' || !('affected' in result) || result.affected !== 1)
    throw new Error('ATTEMPT_LOST');
}

export type BackgroundJobPayload = { runId: string };
export type BackgroundJobContext = {
  runId: string;
  signal: AbortSignal;
  transaction<T>(callback: (transaction: BackgroundJobTransaction) => Promise<T>): Promise<T>;
};

export function requireRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('INVALID_RUN_ID');
  }
  return runId;
}

/** The initial registry contains probes only. Add real families with their migration PRs. */
export function handlerForRole(role: BackgroundWorkerRole) {
  return {
    queue: BACKGROUND_JOB_QUEUES[role],
    options: BACKGROUND_PROBE_JOB_OPTIONS,
    execute: async (context: BackgroundJobContext) => {
      await context.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT 1`);
      });
    },
  };
}

/** ID doubles as the caller's idempotency key, including after a lost acknowledgement. */
export async function enqueueWorkerProbe(
  database: DbInstance,
  boss: PgBoss,
  role: BackgroundWorkerRole,
  runId: string = randomUUID(),
): Promise<string> {
  requireRunId(runId);
  const queue = BACKGROUND_JOB_QUEUES[role];
  return database.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(backgroundJobRuns)
      .values({
        id: runId,
        queue,
        role,
        status: 'queued',
        deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: backgroundJobRuns.id });
    if (!inserted.length) {
      const [existing] = await transaction.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId));
      if (existing?.queue !== queue || existing.role !== role) throw new Error('RUN_ID_CONFLICT');
      return runId;
    }
    const jobId = await boss.send(
      queue,
      { runId },
      { id: runId, ...BACKGROUND_PROBE_JOB_OPTIONS, db: enqueueOn(transaction) },
    );
    if (jobId !== runId) throw new Error('JOB_ENQUEUE_FAILED');
    return runId;
  });
}

/** All data batches, including completion, remain behind the current attempt fence. */
export async function executeBackgroundJob(
  database: DbInstance,
  boss: PgBoss,
  job: JobWithMetadata<BackgroundJobPayload>,
  handler: ReturnType<typeof handlerForRole>,
  shutdownSignal: AbortSignal,
): Promise<'succeeded' | 'failed' | 'stale'> {
  if (
    !job.data ||
    Object.keys(job.data).length !== 1 ||
    requireRunId(job.data.runId) !== job.id ||
    job.name !== handler.queue
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  shutdownSignal.throwIfAborted();
  const token = await claimBackgroundJobRun(database, job.id, job.name, job.retryCount);
  if (!token) return 'stale';
  const lostAttempt = new AbortController();
  const remainingMs = Math.max(1, job.startedOn.getTime() + job.expireInSeconds * 1000 - Date.now());
  const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(remainingMs), lostAttempt.signal]);
  let heartbeatPending: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = withBackgroundJobAttempt(database, job.id, token, async (transaction) => {
      const touched = await boss.touch(job.name, job.id, { db: enqueueOn(transaction) });
      requireSettlement(touched);
      await transaction
        .update(backgroundJobRuns)
        .set({ heartbeatAt: sql`clock_timestamp()` })
        .where(eq(backgroundJobRuns.id, job.id));
    })
      .catch(() => {
        lostAttempt.abort();
      })
      .finally(() => {
        heartbeatPending = undefined;
      });
  }, 10_000);
  heartbeat.unref();
  try {
    signal.throwIfAborted();
    await handler.execute({
      runId: job.id,
      signal,
      transaction: (callback) =>
        withBackgroundJobAttempt(database, job.id, token, async (transaction) => {
          signal.throwIfAborted();
          const result = await callback(transaction);
          signal.throwIfAborted();
          return result;
        }),
    });
    signal.throwIfAborted();
    const settled = await settleBackgroundJobRun(database, job.id, token, async (transaction) => {
      signal.throwIfAborted();
      const completed = await boss.complete(job.name, job.id, undefined, { db: enqueueOn(transaction) });
      requireSettlement(completed);
      return { status: 'succeeded' };
    });
    return settled ? 'succeeded' : 'stale';
  } catch {
    // pg-boss persists thrown errors. Never persist provider URLs, SQL or credentials.
    const settled = await settleBackgroundJobRun(database, job.id, token, async (transaction) => {
      const adapter = enqueueOn(transaction);
      const failed = await boss.fail(job.name, job.id, { code: 'BACKGROUND_JOB_FAILED' }, { db: adapter });
      requireSettlement(failed);
      const retry = await boss.getJobById(job.name, job.id, { db: adapter });
      return { status: retry?.state === 'failed' ? 'failed' : 'retrying', errorCode: 'ATTEMPT_FAILED' };
    });
    return settled ? 'failed' : 'stale';
  } finally {
    clearInterval(heartbeat);
    await heartbeatPending;
  }
}
