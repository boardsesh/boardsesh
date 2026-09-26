import { PgBoss } from 'pg-boss';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
  SPRAY_DETECTION_JOB_OPTIONS,
} from '@boardsesh/shared-schema';
import {
  BACKGROUND_JOB_QUEUES,
  BACKGROUND_JOB_RECONCILE_QUEUE,
  BACKGROUND_PROBE_JOB_OPTIONS,
  jobQueueTransactionAdapter,
} from './background-jobs';

/**
 * The backend's daily popular-board-configs refresh (and the refresh a reader's
 * cache miss asks for). Lives here because the migrator creates the queue.
 */
export const POPULAR_BOARD_CONFIGS_REFRESH_QUEUE = 'popular-board-configs-refresh';

/**
 * `exclusive`: one job queued or running, so the cron and any number of on-miss
 * requests collapse to one. A run takes about 30 s; expiry at 600 s sits under
 * the backend's 900 s Redis lock, so a retry after an expiry finds the lock
 * still held by the stuck run and skips instead of running a second copy.
 */
const POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  expireInSeconds: 600,
  retryLimit: 2,
  retryDelay: 300,
} as const;

/**
 * The backend's hourly `board_climb_popularity` refresh (the popular sort's
 * ranking table, docs/climb-popularity.md). Lives here because the migrator
 * creates the queue.
 */
export const CLIMB_POPULARITY_REFRESH_QUEUE = 'climb-popularity-refresh';

/**
 * `exclusive`: one job queued or running, so a slow run never overlaps the
 * next hour's. An incremental run takes well under a second; a full pass
 * (a board's first build, then weekly) took 34 s for every board on the dev DB.
 * The handler stops itself before 1,500 s, under this expiry, so pg-boss never
 * starts a second copy beside a live one.
 */
const CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  expireInSeconds: 1_800,
  retryLimit: 2,
  retryDelay: 300,
} as const;

/** Only the deployment's reserved migration-owner connection may execute this. */
export async function initializeJobQueueSchema(
  database: Parameters<typeof jobQueueTransactionAdapter>[0],
  runtimeRole?: string,
  detectorRole?: string,
  workerRoles: readonly string[] = [],
): Promise<void> {
  for (const role of [runtimeRole, detectorRole, ...workerRoles]) {
    if (role && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) throw new Error('Invalid job queue role');
  }
  const adapter = jobQueueTransactionAdapter(database);
  const boss = new PgBoss({ db: adapter, supervise: false, schedule: false });
  boss.on('error', () => {
    /* The awaited startup/DDL operation reports failures. */
  });
  try {
    await boss.start();
    // pg-boss 12.33's scheduler creates this queue at runtime. Pre-create it
    // under the owner so scheduler startup needs DML, never schema CREATE.
    await boss.createQueue('__pgboss__send-it', { partition: false });
    await boss.createQueue(SPRAY_DETECTION_DEAD_QUEUE, { partition: false });
    await boss.createQueue(SPRAY_DETECTION_QUEUE, { partition: false, ...SPRAY_DETECTION_JOB_OPTIONS });
    await boss.updateQueue(SPRAY_DETECTION_QUEUE, SPRAY_DETECTION_JOB_OPTIONS);
    await boss.createQueue(SPRAY_DETECTION_RECONCILE_QUEUE, {
      partition: false,
      policy: 'singleton',
      expireInSeconds: 120,
    });
    await boss.createQueue(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {
      partition: false,
      ...POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS,
    });
    const { policy: _popularPolicy, ...mutablePopularOptions } = POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS;
    await boss.updateQueue(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, mutablePopularOptions);
    await boss.createQueue(CLIMB_POPULARITY_REFRESH_QUEUE, {
      partition: false,
      ...CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS,
    });
    const { policy: _climbPopularityPolicy, ...mutableClimbPopularityOptions } = CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS;
    await boss.updateQueue(CLIMB_POPULARITY_REFRESH_QUEUE, mutableClimbPopularityOptions);
    for (const queue of Object.values(BACKGROUND_JOB_QUEUES)) {
      await boss.createQueue(queue, { partition: false, ...BACKGROUND_PROBE_JOB_OPTIONS });
      const { policy: _policy, ...mutableOptions } = BACKGROUND_PROBE_JOB_OPTIONS;
      await boss.updateQueue(queue, mutableOptions);
    }
    const reconcileOptions = {
      ...BACKGROUND_PROBE_JOB_OPTIONS,
      policy: 'singleton' as const,
    };
    await boss.createQueue(BACKGROUND_JOB_RECONCILE_QUEUE, { partition: false, ...reconcileOptions });
    const { policy: _reconcilePolicy, ...mutableReconcileOptions } = reconcileOptions;
    await boss.updateQueue(BACKGROUND_JOB_RECONCILE_QUEUE, mutableReconcileOptions);
    for (const role of [runtimeRole, detectorRole, ...workerRoles]) {
      if (!role) continue;
      // Identifiers were validated above. No database/schema CREATE or ownership.
      await adapter.executeSql(`GRANT USAGE ON SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO "${role}"`);
    }
    // Restricted worker logins are pre-provisioned by operators. This source
    // runs only in the deployment migrator, never at worker startup.
    for (const role of workerRoles) {
      await adapter.executeSql(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await adapter.executeSql(`GRANT SELECT, INSERT, UPDATE ON public.background_job_runs TO "${role}"`);
    }
    if (detectorRole) {
      await adapter.executeSql(`GRANT USAGE ON SCHEMA public TO "${detectorRole}"`);
      await adapter.executeSql(`GRANT USAGE ON TYPE public.spray_detection_status TO "${detectorRole}"`);
      await adapter.executeSql(
        `GRANT SELECT ON public.spray_walls, public.spray_wall_versions, public.user_boards TO "${detectorRole}"`,
      );
      await adapter.executeSql(`GRANT SELECT, UPDATE ON public.spray_wall_detections TO "${detectorRole}"`);
    }
  } finally {
    await boss.stop({ graceful: true, close: false });
  }
}
