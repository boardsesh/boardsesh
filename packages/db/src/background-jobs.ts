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

export const BACKGROUND_JOB_QUEUES: Record<BackgroundWorkerRole, string> = {
  'interactive-import': 'background-probe-interactive-import',
  'routine-provider': 'background-probe-routine-provider',
  'maintenance-delivery': 'background-probe-maintenance-delivery',
  batch: 'background-probe-batch',
};

export const BACKGROUND_PROBE_JOB_OPTIONS = {
  policy: 'standard',
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 120,
  expireInSeconds: 120,
  heartbeatSeconds: 30,
  retentionSeconds: 7 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const satisfies Omit<Queue, 'name'>;

export const BACKGROUND_JOB_RECONCILE_QUEUE = 'background-job-reconcile';
