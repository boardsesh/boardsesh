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
