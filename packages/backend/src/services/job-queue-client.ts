import { PgBoss, type Db } from 'pg-boss';
import { reportJobQueueError } from './job-queue-errors';

export async function assertQueuePrimary(database: Db): Promise<void> {
  const result = await database.executeSql(
    "SELECT pg_is_in_recovery() AS recovery, current_setting('transaction_read_only') AS read_only",
  );
  const row: unknown = result.rows[0];
  if (
    !row ||
    typeof row !== 'object' ||
    !('recovery' in row) ||
    row.recovery !== false ||
    !('read_only' in row) ||
    row.read_only !== 'off'
  ) {
    throw new Error('Job queue requires a writable primary');
  }
}

/**
 * Refuse owner/superuser credentials even when a deployment uses the right username.
 *
 * The backend runtime login also lacks schema CREATE, so the privilege bits alone
 * cannot tell it apart from a worker. The migrator grants that role CRUD on every
 * application table, including DELETE on the ledger, while worker logins only ever
 * receive SELECT/INSERT/UPDATE there (the backend reconciler owns purging). A login
 * that can delete ledger rows is therefore never a restricted worker identity.
 */
export async function assertWorkerPrivileges(database: Db): Promise<void> {
  const result = await database.executeSql(`SELECT
    rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS privileged,
    has_schema_privilege(current_user, 'public', 'CREATE') OR has_schema_privilege(current_user, 'pgboss', 'CREATE') AS can_create,
    has_table_privilege(current_user, 'public.background_job_runs', 'SELECT')
      AND has_table_privilege(current_user, 'public.background_job_runs', 'INSERT')
      AND has_table_privilege(current_user, 'public.background_job_runs', 'UPDATE') AS ledger_access,
    has_table_privilege(current_user, 'public.background_job_runs', 'DELETE') AS ledger_delete
    FROM pg_roles WHERE rolname = current_user`);
  const row: unknown = result.rows[0];
  if (
    !row ||
    typeof row !== 'object' ||
    !('privileged' in row) ||
    row.privileged !== false ||
    !('can_create' in row) ||
    row.can_create !== false ||
    !('ledger_access' in row) ||
    row.ledger_access !== true ||
    !('ledger_delete' in row) ||
    row.ledger_delete !== false
  ) {
    throw new Error('Worker requires a restricted database login and migrated ledger grants');
  }
}

/**
 * pg-boss background timers, slowed to what our queues need (docs/db-connectivity.md,
 * "pg-boss timers"). Every backend replica runs these, and each tick races the
 * other replicas for the single `pgboss.version` row, so a faster tick costs
 * lock waits, not just a cheap UPDATE.
 *
 * - `flowIntervalSeconds` 3600: the flow gate resolves `boss.flow()` / job
 *   dependencies. Nothing uses them (no `.flow(` in the repo, and
 *   `pgboss.job_dependency` is empty in production), so the 5 s default was
 *   about 52k no-op UPDATEs a day. A future flow user must lower this back,
 *   or children unblock up to an hour late.
 * - `cronMonitorIntervalSeconds` 45: the maximum pg-boss 12 accepts (a larger
 *   value throws in the constructor). The timekeeper still matches every
 *   occurrence in the preceding 60 s, so per-minute crons do not skip.
 * - `monitorIntervalSeconds` 120: the queue-stats aggregate seq-scans
 *   `pgboss.job_common`. Job expiry and missed-heartbeat checks ride the same
 *   pass, and that pass only runs on a 60 s supervise tick once 120 s have
 *   passed, so a job whose worker died is failed 2 to 3 min late instead of
 *   1 to 2 (spray detection's 30 s heartbeat included).
 */
export const JOB_QUEUE_TIMER_OPTIONS = {
  flowIntervalSeconds: 3600,
  cronMonitorIntervalSeconds: 45,
  monitorIntervalSeconds: 120,
} as const;

/**
 * Poll interval for the backend's maintenance workers (the reconcile crons and
 * the detection dead-letter queue). The crons get one job a minute, so the 2 s
 * default was 30 fetches per replica for every job. The dead-letter queue only
 * gets a job when a detection exhausts its retries, and marking that detection
 * failed up to 30 s later adds little to a path that already spent over a
 * minute on three backed-off retries.
 */
export const MAINTENANCE_POLLING_INTERVAL_SECONDS = 30;

/**
 * How long a worker's pg-boss pool waits for a query's answer before giving up
 * on the connection (#6683). A worker's pool holds one connection, and pg-pool
 * never takes back a connection that is checked out. A query that never gets
 * an answer, such as a fetch sent down a socket the network silently dropped
 * after acknowledging it, used to hold that one slot forever: every later
 * checkout then waited 10 s and failed, once a minute, for days.
 *
 * With this set, pg rejects the stuck query, pg-pool discards the client, and
 * pg destroys its socket. The next poll opens a fresh connection. Giving up
 * tells the server nothing, so this deadline is only for a server that has
 * gone silent. A live server that is merely slow is handled by
 * {@link WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS} first.
 *
 * Workers only. Every worker statement on this pool is a short read or the
 * fetch; run I/O goes through the Drizzle adapter. The backend's pool runs
 * supervision passes that can legitimately take longer. See
 * docs/db-connectivity.md, "Worker job-queue read deadline".
 */
export const WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS = 30_000;

/**
 * The server-side deadline for the same statements, deliberately shorter than
 * {@link WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS}. A fetch the client abandons keeps
 * running on the server: a backend waiting on a lock never looks at its socket.
 * Once the lock clears it commits, and activates a job no worker receives,
 * while the poll loop has already sent the next fetch on a fresh connection.
 * With this set, a live server cancels the statement at 25 s and rolls it back
 * (SQLSTATE 57014) before the client gives up, so nothing commits behind the
 * worker's back. pg sends it as a startup parameter, which a direct connection
 * honours (workers connect straight to the primary; see docs/db-connectivity.md,
 * "PgBouncer: parked").
 */
export const WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS = 25_000;

// pg-boss hands its whole config to `pg.Pool`, which hands it to each
// `pg.Client`, so pg reads both from here. pg-boss's option type just does not
// list them.
const WORKER_JOB_QUEUE_POOL_OPTIONS: { query_timeout: number; statement_timeout: number } = {
  query_timeout: WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
  statement_timeout: WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
};

/** Shared connection factory. Only the backend owns scheduling/supervision. */
export function createJobQueueClient(options: {
  connectionString: string;
  poolSize: number;
  owner: 'backend' | 'worker';
  testBootstrap?: boolean;
}): PgBoss {
  if (
    !Number.isInteger(options.poolSize) ||
    options.poolSize < 1 ||
    (options.owner === 'worker' && options.poolSize !== 1)
  ) {
    throw new Error('Invalid job queue pool size');
  }
  const instance = new PgBoss({
    connectionString: options.connectionString,
    max: options.poolSize,
    connectionTimeoutMillis: 10_000,
    ...(options.owner === 'worker' ? WORKER_JOB_QUEUE_POOL_OPTIONS : {}),
    migrate: options.owner === 'backend' && options.testBootstrap === true,
    schedule: options.owner === 'backend',
    supervise: options.owner === 'backend',
    // Owner migrations maintain indexes; restricted runtimes never perform DDL.
    reindex: false,
    ...JOB_QUEUE_TIMER_OPTIONS,
  });
  instance.on('error', (error: unknown) => {
    reportJobQueueError(error, { owner: options.owner, poolSize: options.poolSize });
  });
  return instance;
}
