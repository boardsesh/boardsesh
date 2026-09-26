import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { BackgroundJobStatus } from '../background-jobs';
import type { DbInstance } from '../client';
import { backgroundJobRuns } from '../schema/app/background-job-runs';

export type BackgroundJobTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

// Read-only projection of the pinned pg-boss 12.33 schema. Deliberately absent
// from the schema barrel: pg-boss owns its own migrations.
const queueJobs = pgSchema('pgboss').table('job', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  state: text('state').notNull(),
  retryCount: integer('retry_count').notNull(),
  startedOn: timestamp('started_on', { withTimezone: true }),
  expireSeconds: integer('expire_seconds').notNull(),
  heartbeatOn: timestamp('heartbeat_on', { withTimezone: true }),
  heartbeatSeconds: integer('heartbeat_seconds'),
});

export class BackgroundJobAttemptLostError extends Error {
  constructor() {
    super('Background job attempt is no longer current');
    this.name = 'BackgroundJobAttemptLostError';
  }
}

async function lockRun(transaction: BackgroundJobTransaction, runId: string) {
  const [run] = await transaction.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId)).for('update');
  return run;
}

async function lockActiveQueueAttempt(
  transaction: BackgroundJobTransaction,
  runId: string,
  queue: string,
  retryCount: number,
) {
  const [job] = await transaction
    .select({
      id: queueJobs.id,
      leaseDeadlineAt: sql<Date>`LEAST(
        ${queueJobs.startedOn} + ${queueJobs.expireSeconds} * interval '1 second',
        ${queueJobs.heartbeatOn} + ${queueJobs.heartbeatSeconds} * interval '1 second')`.mapWith(queueJobs.startedOn),
    })
    .from(queueJobs)
    .where(
      and(
        eq(queueJobs.id, runId),
        eq(queueJobs.name, queue),
        eq(queueJobs.state, 'active'),
        eq(queueJobs.retryCount, retryCount),
        sql`${queueJobs.startedOn} + ${queueJobs.expireSeconds} * interval '1 second' > clock_timestamp()`,
        sql`(${queueJobs.heartbeatSeconds} IS NULL OR
          ${queueJobs.heartbeatOn} + ${queueJobs.heartbeatSeconds} * interval '1 second' > clock_timestamp())`,
      ),
    )
    .for('update');
  return job;
}

async function deadlineIsCurrent(transaction: BackgroundJobTransaction, runId: string) {
  const [run] = await transaction
    .select({ id: backgroundJobRuns.id })
    .from(backgroundJobRuns)
    .where(and(eq(backgroundJobRuns.id, runId), sql`${backgroundJobRuns.deadlineAt} > clock_timestamp()`));
  return Boolean(run);
}

/** Call only after taking the matching background_job_runs row lock. */
export async function readBackgroundJobQueueAttempt(
  transaction: BackgroundJobTransaction,
  runId: string,
  queue: string,
) {
  const [job] = await transaction
    .select({
      state: queueJobs.state,
      retryCount: queueJobs.retryCount,
      isLeaseLive: sql<boolean>`COALESCE(
        ${queueJobs.startedOn} + ${queueJobs.expireSeconds} * interval '1 second' > clock_timestamp()
        AND (${queueJobs.heartbeatSeconds} IS NULL OR
          ${queueJobs.heartbeatOn} + ${queueJobs.heartbeatSeconds} * interval '1 second' > clock_timestamp()), false)`,
    })
    .from(queueJobs)
    .where(and(eq(queueJobs.id, runId), eq(queueJobs.name, queue)))
    .for('update');
  return job;
}

/** All consumers/reconcilers must take the ledger lock before the pg-boss lock. */
export async function claimBackgroundJobRun(
  database: DbInstance,
  runId: string,
  queue: string,
  retryCount: number,
): Promise<string | null> {
  return database.transaction(async (transaction) => {
    const run = await lockRun(transaction, runId);
    if (
      !run ||
      run.queue !== queue ||
      !['queued', 'running', 'retrying'].includes(run.status) ||
      run.attemptNumber >= retryCount ||
      !(await deadlineIsCurrent(transaction, runId)) ||
      !(await lockActiveQueueAttempt(transaction, runId, queue, retryCount))
    ) {
      return null;
    }
    const attemptToken = randomUUID();
    await transaction
      .update(backgroundJobRuns)
      .set({
        status: 'running',
        attemptToken,
        attemptNumber: retryCount,
        startedAt: sql`clock_timestamp()`,
        heartbeatAt: sql`clock_timestamp()`,
        errorCode: null,
      })
      .where(eq(backgroundJobRuns.id, runId));
    return attemptToken;
  });
}

/**
 * Put each bounded database batch inside this callback, never network requests.
 * Both generations remain locked through its commit; expiry rolls writes back.
 */
export async function withBackgroundJobAttempt<Result>(
  database: DbInstance,
  runId: string,
  attemptToken: string,
  callback: (transaction: BackgroundJobTransaction) => Promise<Result>,
): Promise<Result> {
  return database.transaction(async (transaction) => {
    const run = await lockRun(transaction, runId);
    if (
      !run ||
      run.status !== 'running' ||
      run.attemptToken !== attemptToken ||
      !(await deadlineIsCurrent(transaction, runId)) ||
      !(await lockActiveQueueAttempt(transaction, runId, run.queue, run.attemptNumber))
    ) {
      throw new BackgroundJobAttemptLostError();
    }
    const result = await callback(transaction);
    if (
      !(await deadlineIsCurrent(transaction, runId)) ||
      !(await lockActiveQueueAttempt(transaction, runId, run.queue, run.attemptNumber))
    ) {
      throw new BackgroundJobAttemptLostError();
    }
    return result;
  });
}

export async function heartbeatBackgroundJobRun(
  database: DbInstance,
  runId: string,
  attemptToken: string,
): Promise<boolean> {
  try {
    return await withBackgroundJobAttempt(database, runId, attemptToken, async (transaction) => {
      await transaction
        .update(backgroundJobRuns)
        .set({ heartbeatAt: sql`clock_timestamp()` })
        .where(eq(backgroundJobRuns.id, runId));
      return true;
    });
  } catch (error) {
    if (error instanceof BackgroundJobAttemptLostError) return false;
    throw error;
  }
}

export async function finishBackgroundJobRun(
  database: DbInstance,
  runId: string,
  attemptToken: string,
  status: Exclude<BackgroundJobStatus, 'queued' | 'running'>,
  errorCode?: string,
): Promise<boolean> {
  try {
    return await withBackgroundJobAttempt(database, runId, attemptToken, async (transaction) => {
      await transaction
        .update(backgroundJobRuns)
        .set({
          status,
          attemptToken: null,
          finishedAt: status === 'retrying' ? null : sql`clock_timestamp()`,
          errorCode: errorCode ?? null,
        })
        .where(eq(backgroundJobRuns.id, runId));
      return true;
    });
  } catch (error) {
    if (error instanceof BackgroundJobAttemptLostError) return false;
    throw error;
  }
}

/**
 * Complete/fail pg-boss through the callback's transaction adapter, then commit
 * the ledger outcome atomically. The callback must reject an affected count
 * other than one. Never fall back to settling on a separate pooled connection.
 */
export async function settleBackgroundJobRun(
  database: DbInstance,
  runId: string,
  attemptToken: string,
  callback: (transaction: BackgroundJobTransaction) => Promise<{
    status: 'succeeded' | 'retrying' | 'failed';
    errorCode?: string;
  }>,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const run = await lockRun(transaction, runId);
      if (
        !run ||
        run.status !== 'running' ||
        run.attemptToken !== attemptToken ||
        !(await deadlineIsCurrent(transaction, runId))
      ) {
        throw new BackgroundJobAttemptLostError();
      }
      const job = await lockActiveQueueAttempt(transaction, runId, run.queue, run.attemptNumber);
      if (!job) throw new BackgroundJobAttemptLostError();
      const outcome = await callback(transaction);
      // The callback intentionally changed queue state. Check the lease captured
      // under its lock instead of requiring the settled row to remain active.
      const [unexpired] = await transaction
        .select({ id: backgroundJobRuns.id })
        .from(backgroundJobRuns)
        .where(
          and(
            eq(backgroundJobRuns.id, runId),
            sql`${backgroundJobRuns.deadlineAt} > clock_timestamp()`,
            sql`${job.leaseDeadlineAt.toISOString()}::timestamptz > clock_timestamp()`,
          ),
        );
      if (!unexpired) throw new BackgroundJobAttemptLostError();
      await transaction
        .update(backgroundJobRuns)
        .set({
          status: outcome.status,
          attemptToken: null,
          finishedAt: outcome.status === 'retrying' ? null : sql`clock_timestamp()`,
          errorCode: outcome.errorCode ?? null,
        })
        .where(eq(backgroundJobRuns.id, runId));
      return true;
    });
  } catch (error) {
    if (error instanceof BackgroundJobAttemptLostError) return false;
    throw error;
  }
}

/** Backend-owned repair survives worker outages. pg-boss alone owns requeueing. */
export async function reconcileBackgroundJobRun(database: DbInstance, runId: string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const run = await lockRun(transaction, runId);
    if (!run || !['queued', 'running', 'retrying'].includes(run.status)) return false;
    const job = await readBackgroundJobQueueAttempt(transaction, runId, run.queue);
    let status: BackgroundJobStatus;
    let errorCode: string;
    if (!(await deadlineIsCurrent(transaction, runId))) {
      status = 'failed';
      errorCode = 'QUEUE_EXPIRED';
    } else if (!job) {
      status = 'failed';
      errorCode = 'JOB_MISSING';
    } else if (job.state === 'failed' || job.state === 'cancelled') {
      status = job.state;
      errorCode = job.state === 'failed' ? 'RETRIES_EXHAUSTED' : 'JOB_CANCELLED';
    } else if (job.state === 'completed') {
      status = 'failed';
      errorCode = 'RESULT_MISSING';
    } else if (
      run.status === 'running' &&
      (job.state !== 'active' || !job.isLeaseLive || job.retryCount !== run.attemptNumber)
    ) {
      status = 'retrying';
      errorCode = 'ATTEMPT_EXPIRED';
    } else {
      return false;
    }
    await transaction
      .update(backgroundJobRuns)
      .set({
        status,
        attemptToken: null,
        finishedAt: status === 'retrying' ? null : sql`clock_timestamp()`,
        errorCode,
      })
      .where(eq(backgroundJobRuns.id, runId));
    return true;
  });
}
