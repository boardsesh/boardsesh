import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { initializeJobQueueSchema, POPULAR_BOARD_CONFIGS_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';
import { retrySprayDetectionAttempt } from '@boardsesh/db/queries';
import { SPRAY_DETECTION_QUEUE, SPRAY_DETECTION_RECONCILE_QUEUE } from '@boardsesh/shared-schema';

describe('owner-only queue initialization', () => {
  it('allows runtime scheduling and worker DML without schema CREATE', async () => {
    const role = `detector_test_${randomUUID().replaceAll('-', '')}`;
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.searchParams.set('options', `-c role=${role}`);
    const restricted = postgres(workerUrl.toString(), { max: 1 });
    const runtime = new PgBoss({
      connectionString: workerUrl.toString(),
      max: 1,
      migrate: false,
      supervise: false,
      schedule: true,
    });
    runtime.on('error', () => {});
    const [originalTypeAcl] = await owner`
      SELECT EXISTS (
        SELECT 1 FROM pg_type
        CROSS JOIN LATERAL aclexplode(COALESCE(typacl, acldefault('T', typowner))) AS privilege
        WHERE oid = 'public.spray_detection_status'::regtype
          AND privilege.grantee = 0 AND privilege.privilege_type = 'USAGE'
      ) AS public_usage`;
    try {
      await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
      // Production's ACL reconciler removes the default PUBLIC type grant.
      await owner`REVOKE ALL ON TYPE public.spray_detection_status FROM PUBLIC`;
      await initializeJobQueueSchema(drizzle(owner), undefined, role);
      const [typeGrant] =
        await restricted`SELECT has_type_privilege(current_user, 'public.spray_detection_status', 'USAGE') AS permitted`;
      expect(typeGrant.permitted).toBe(true);
      await expect(restricted`CREATE TABLE public.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await expect(restricted`CREATE TABLE pgboss.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await runtime.start();
      await runtime.schedule(SPRAY_DETECTION_RECONCILE_QUEUE, '* * * * *');
      // The popular-configs refresh: created by the owner, scheduled and
      // requested by the runtime role.
      await runtime.schedule(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, '17 4 * * *', null, { tz: 'UTC' });
      const refreshId = await runtime.send(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {});
      expect(refreshId).toBeTruthy();
      // `exclusive`: a second request while one is queued is dropped.
      expect(await runtime.send(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {})).toBeNull();
      const id = await runtime.send(SPRAY_DETECTION_QUEUE, { detectionId: randomUUID() });
      expect(id).toBeTruthy();
      const jobs = await runtime.fetch(SPRAY_DETECTION_QUEUE);
      expect(jobs).toHaveLength(1);
      await runtime.complete(SPRAY_DETECTION_QUEUE, jobs[0].id);
      expect((await runtime.getJobById(SPRAY_DETECTION_QUEUE, jobs[0].id))?.state).toBe('completed');
      const permitted = await restricted`SELECT id FROM spray_wall_detections LIMIT 1`;
      expect(Array.isArray(permitted)).toBe(true);
      // Exercise the worker UPDATE query's table permissions without changing a row.
      await retrySprayDetectionAttempt(drizzle(restricted), randomUUID(), randomUUID());
    } finally {
      if (originalTypeAcl.public_usage) await owner`GRANT USAGE ON TYPE public.spray_detection_status TO PUBLIC`;
      await runtime.stop({ graceful: true, close: true });
      await restricted.end();
      // This random NOLOGIN test role owns no objects, only grants in this
      // isolated worker database. Revoke them before removing the test role.
      await owner.unsafe(`DROP OWNED BY "${role}"`);
      await owner.unsafe(`DROP ROLE "${role}"`);
      await owner.end();
    }
  }, 30_000);
});
