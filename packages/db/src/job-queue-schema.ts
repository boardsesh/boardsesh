import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type Db } from 'pg-boss';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
  SPRAY_DETECTION_JOB_OPTIONS,
} from '@boardsesh/shared-schema';

/** Only the deployment's reserved migration-owner connection may execute this. */
export async function initializeJobQueueSchema(
  database: Parameters<typeof fromDrizzle>[0],
  runtimeRole?: string,
  detectorRole?: string,
): Promise<void> {
  for (const role of [runtimeRole, detectorRole]) {
    if (role && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) throw new Error('Invalid job queue role');
  }
  const drizzleAdapter = fromDrizzle(database, sql);
  // updateQueue supplies a JSON object. postgres-js needs that parameter
  // serialized; the generic Drizzle adapter has no column JSON encoder here.
  const adapter: Db = {
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
    for (const role of [runtimeRole, detectorRole]) {
      if (!role) continue;
      // Identifiers were validated above. No database/schema CREATE or ownership.
      await adapter.executeSql(`GRANT USAGE ON SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO "${role}"`);
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
