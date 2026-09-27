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
  'refresh-recommendations',
  'refresh-hold-features',
  'refresh-climb-grades',
  'refresh-climb-neighbors',
  'export-board-snapshots',
  'refresh-moonboard-angle-estimates',
  'refresh-moonboard-wide-angle-estimates',
  'aurora-user-sync',
  'kilter-user-sync',
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
