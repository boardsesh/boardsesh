/**
 * The backend's job queue: pg-boss, in this process, on the same Postgres.
 *
 * `docs/partner-workouts-internal.md` ("The job queue") is the design. The short
 * version of why it is pg-boss and not BullMQ on the Redis we already run:
 *
 * 1. **A job can commit with the state change.** `send()` takes a `db` option, so
 *    the job insert rides the same transaction as the row it is about. A Redis
 *    queue cannot join a Postgres transaction, which means an outbox table and a
 *    relay to drain it — and the relay is the sweep we were trying to delete.
 * 2. **Nothing new to make durable.** Today's Redis use all tolerates loss: rate
 *    limits, nonces, a Streams bus with `MAXLEN ~10000`. A queue would be the
 *    first thing on it that does not.
 *
 * pg-boss polls with `SKIP LOCKED` rather than LISTEN/NOTIFY, so it keeps working
 * behind a connection pooler. The deployment migrator initializes its `pgboss`
 * schema under the reserved migration owner; runtime startup disables DDL.
 * That schema is outside `packages/db/drizzle`, so
 * `check:db-migrations` does not see it and `pg_dump` carries it like any other
 * schema. See `docs/db-migrations.md`.
 *
 * Two notes on the installed version (12.x), because the design doc was written
 * against assumptions and asked for them to be checked:
 *
 * - `pg-boss` is ESM with a NAMED export. `import PgBoss from 'pg-boss'` gets you
 *   `default is not a constructor`.
 * - It ships an official `fromDrizzle(tx, sql)` adapter, so the `{ db }` handle
 *   is a supported API rather than something to hand-roll against
 *   `IDatabase.executeSql`. `enqueueOn()` below is the only place that knows it.
 */

import { getConnectionConfig } from '@boardsesh/db/client';
import { jobQueueTransactionAdapter } from '@boardsesh/db/background-jobs';
import type { PgBoss } from 'pg-boss';
import { assertQueuePrimary, createJobQueueClient } from './job-queue-client';
// `IDatabase` is published under the name `Db`.
import type { Db, SendOptions } from 'pg-boss';

import { logger } from '../utils/logger';

/** Just enough of a drizzle transaction for the adapter; avoids naming the generic. */
type DrizzleTransaction = Parameters<typeof jobQueueTransactionAdapter>[0];

/**
 * The `{ db }` handle that makes `send()` enqueue inside a caller's transaction:
 * roll the transaction back and the job was never queued.
 *
 * Every enqueue that has a transaction in hand should go through this. An
 * enqueue outside one is a job that can exist for a row that rolled back.
 */
export function enqueueOn(tx: DrizzleTransaction): Db {
  return jobQueueTransactionAdapter(tx);
}

/** Options every queue in this service shares unless it says otherwise. */
export const DEFAULT_JOB_OPTIONS: SendOptions = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  // `retryBackoff` grows as `retryDelay * 2^retryCount` with jitter and, left
  // alone, has NO ceiling — the fourth attempt at a 15 s base is already minutes
  // out. Cap it so a retry cannot drift past the window a climber is still
  // watching a spinner in.
  retryDelayMax: 120,
};

let boss: PgBoss | null = null;

/** The running queue, or null before `startJobQueue()` / after `stopJobQueue()`. */
export function getJobQueue(): PgBoss | null {
  return boss;
}

export function requireJobQueue(): PgBoss {
  if (!boss) throw new Error('job queue is not running; call startJobQueue() first');
  return boss;
}

/**
 * pg-boss pool per backend replica when `PGBOSS_POOL_SIZE` is unset. Its work is
 * short timer statements and a handful of once-a-minute jobs, which 2
 * connections serve; see the connection budget in docs/db-connectivity.md.
 */
export const DEFAULT_PGBOSS_POOL_SIZE = 2;

export async function startJobQueue(): Promise<PgBoss> {
  if (boss) return boss;

  const instance = createJobQueueClient({
    connectionString: getConnectionConfig().connectionString,
    poolSize: Number(process.env.PGBOSS_POOL_SIZE ?? DEFAULT_PGBOSS_POOL_SIZE),
    owner: 'backend',
    testBootstrap: process.env.NODE_ENV === 'test',
  });
  try {
    await instance.start();
    await assertQueuePrimary(instance.getDb());
  } catch (error) {
    await instance.stop({ graceful: false, close: true });
    throw error;
  }
  boss = instance;
  logger.info('[job-queue] started');
  return instance;
}

export async function stopJobQueue(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  // Graceful: let an in-flight job finish rather than orphaning it into the
  // supervisor's reclaim window on every deploy. `timeout` bounds that wait so a
  // wedged handler cannot hold the deploy open past Railway's drain window
  // (`drainingSeconds = 15` in railway.toml).
  await instance.stop({ graceful: true, close: true, timeout: 10_000 });
  logger.info('[job-queue] stopped');
}
