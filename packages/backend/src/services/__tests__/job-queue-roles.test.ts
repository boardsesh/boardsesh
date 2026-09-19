import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
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
    try {
      await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
      await initializeJobQueueSchema(drizzle(owner), undefined, role);
      await expect(restricted`CREATE TABLE public.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await expect(restricted`CREATE TABLE pgboss.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await runtime.start();
      await runtime.schedule(SPRAY_DETECTION_RECONCILE_QUEUE, '* * * * *');
      const id = await runtime.send(SPRAY_DETECTION_QUEUE, { detectionId: randomUUID() });
      expect(id).toBeTruthy();
      const jobs = await runtime.fetch(SPRAY_DETECTION_QUEUE);
      expect(jobs).toHaveLength(1);
      await runtime.complete(SPRAY_DETECTION_QUEUE, jobs[0].id);
      expect((await runtime.getJobById(SPRAY_DETECTION_QUEUE, jobs[0].id))?.state).toBe('completed');
      const permitted = await restricted`SELECT id FROM spray_wall_detections LIMIT 1`;
      expect(Array.isArray(permitted)).toBe(true);
    } finally {
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
