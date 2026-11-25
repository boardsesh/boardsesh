import { sql } from 'drizzle-orm';
import { fromDrizzle, type Db, type Queue } from 'pg-boss';

/** Preserve SQL arrays/dates while encoding pg-boss JSON arguments for postgres-js. */
export function jobQueueTransactionAdapter(database: Parameters<typeof fromDrizzle>[0]): Db {
  const drizzleAdapter = fromDrizzle(database, sql);
  // updateQueue and settlement output supply objects without a Drizzle column
  // encoder. postgres-js requires their JSON representation as a parameter.
  return {
    executeSql: (statement, parameters) =>
      drizzleAdapter.executeSql(
        statement,
        parameters?.map((parameter) =>
          parameter !== null &&
          typeof parameter === 'object' &&
          !Array.isArray(parameter) &&
          !(parameter instanceof Date)
            ? JSON.stringify(parameter)
            : parameter,
        ),
      ),
  };
}

/** Queue ownership is shared by owner-only bootstrap and runtime allowlists. */
export const BACKGROUND_WORKER_ROLES = [
  'interactive-import',
  'routine-provider',
  'maintenance-delivery',
  'batch',
  'cnc-interactive',
  'cnc-generation',
] as const;

export type BackgroundWorkerRole = (typeof BACKGROUND_WORKER_ROLES)[number];
export type BackgroundJobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Job families: the unit a worker dispatches on. The run row carries the family
 * and its validated payload; the queue carries only `{ runId }`. Each later
 * family is added here by the PR that ships its module.
 */
export const BACKGROUND_JOB_FAMILIES = [
  'worker-probe',
  'cnc-computation',
  'cnc-generation',
  'refresh-recommendations',
  'refresh-hold-features',
  'refresh-climb-grades',
  'refresh-climb-neighbors',
  'export-board-snapshots',
  'refresh-moonboard-angle-estimates',
  'refresh-moonboard-wide-angle-estimates',
  'aurora-user-sync',
  'kilter-user-sync',
  'provider-routine-cycle',
  'aurora-shared-sync',
  'kilter-catalog-sync',
  'moonboard-locations-sync',
  'climb-stats-self-heal',
  'user-data-export',
  'spray-wall-art',
  'spray-wall-health',
  'community-monthly-stats',
  'reclaim-logbook-snapshots',
  'prune-logbook-changes',
] as const;

export type BackgroundJobFamily = (typeof BACKGROUND_JOB_FAMILIES)[number];

export function isBackgroundJobFamily(name: string): name is BackgroundJobFamily {
  return (BACKGROUND_JOB_FAMILIES as readonly string[]).includes(name);
}

/**
 * One family queue per role; each worker consumes only its own. `stately`
 * allows one queued plus one active job per singleton key, so every send MUST
 * pass a `singletonKey` (the run ID when the family has no natural key):
 * without one, every job on the queue shares the empty key and a second
 * enqueue is silently dropped.
 */
export const BACKGROUND_JOB_QUEUES: Record<BackgroundWorkerRole, string> = {
  'interactive-import': 'background-interactive-import',
  'routine-provider': 'background-routine-provider',
  'maintenance-delivery': 'background-maintenance-delivery',
  batch: 'background-batch',
  'cnc-interactive': 'background-cnc-interactive',
  'cnc-generation': 'background-cnc-generation',
};

/**
 * Queue-level defaults. Every family sends its own expiry/retry/heartbeat
 * options per job, so these apply only to a send that omits them. The policy is
 * immutable once `createQueue` has run.
 */
export const BACKGROUND_JOB_QUEUE_OPTIONS = {
  policy: 'stately',
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 120,
  expireInSeconds: 300,
  heartbeatSeconds: 30,
  retentionSeconds: 7 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const satisfies Omit<Queue, 'name'>;

/**
 * The backend-owned schedule trigger queue. `boss.schedule()` drops one
 * `{ family, key }` job here per cron tick; the backend's handler runs the
 * schedule's fan-out and enqueues the real family jobs. Workers never consume it.
 */
export const BACKGROUND_SCHEDULE_QUEUE = 'background-schedule';

export const BACKGROUND_SCHEDULE_QUEUE_OPTIONS = {
  policy: 'standard',
  retryLimit: 2,
  retryDelay: 30,
  expireInSeconds: 300,
  retentionSeconds: 7 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const satisfies Omit<Queue, 'name'>;

export const BACKGROUND_JOB_RECONCILE_QUEUE = 'background-job-reconcile';

/**
 * How long a worker's pg-boss pool waits for a query's answer before giving up
 * on the connection (#6683). A worker's pool holds one connection (the hold
 * detector's holds three), and pg-pool
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
 * Workers only: the background workers' pools and the spray-wall hold
 * detector's. Every statement on those pools is a short read, the fetch or a
 * completion; run I/O goes through the Drizzle adapter. The backend's pool runs
 * supervision passes that can legitimately take longer. The detector went four
 * days without claiming a job (2026-11-21) because it built its pool without
 * these. See
 * docs/operations/db-connectivity.md, "Worker job-queue read deadline".
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
 * honours (workers connect straight to the primary; see docs/operations/db-connectivity.md,
 * "PgBouncer: parked").
 */
export const WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS = 25_000;

// pg-boss hands its whole config to `pg.Pool`, which hands it to each
// `pg.Client`, so pg reads both from here. pg-boss's option type just does not
// list them.
export const WORKER_JOB_QUEUE_POOL_OPTIONS: { query_timeout: number; statement_timeout: number } = {
  query_timeout: WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
  statement_timeout: WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
};
