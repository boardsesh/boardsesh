import { randomInt } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDatabaseUrl } from '../../__tests__/worker-db';
import {
  WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
  WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
  createJobQueueClient,
} from '../job-queue-client';

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

/** pg-boss's default Db, opened without starting pg-boss itself. */
type QueuePool = {
  open(): Promise<void>;
  close(): Promise<void>;
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openWorkerPool() {
  const boss = createJobQueueClient({ connectionString: getWorkerDatabaseUrl(), poolSize: 1, owner: 'worker' });
  const pool = boss.getDb() as unknown as QueuePool;
  await pool.open();
  cleanups.push(() => pool.close());
  return pool;
}

describe('the worker job-queue pool against a real server (#6683)', () => {
  it('runs every statement under the server-side deadline', async () => {
    const pool = await openWorkerPool();
    const { rows } = await pool.executeSql('SHOW statement_timeout');
    expect(rows).toEqual([{ statement_timeout: `${WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS / 1000}s` }]);
  });

  it(
    'rolls back a fetch stuck behind a lock on the server, so it cannot commit after the worker gives up',
    async () => {
      const url = getWorkerDatabaseUrl();
      const holder = postgres(url, { max: 1, onnotice: () => {} });
      const listener = postgres(url, { max: 1, onnotice: () => {} });
      cleanups.push(
        () => holder.end(),
        () => listener.end(),
      );
      const key = randomInt(1, 2 ** 31 - 1);
      const channel = `job_queue_deadline_${key}`;
      const delivered: string[] = [];
      await listener.listen(channel, (payload) => delivered.push(payload));
      // The advisory lock stands in for whatever blocks the fetch's UPDATE (a pg-boss
      // migration, VACUUM FULL), and NOTIFY stands in for its write: it is delivered
      // only if the statement commits. Parameterised, so pg uses the extended
      // protocol like pg-boss's fetch.
      await holder`SELECT pg_advisory_lock(${key})`;
      const pool = await openWorkerPool();

      const startedAt = performance.now();
      const outcome = await pool
        .executeSql('SELECT pg_advisory_xact_lock($1::bigint), pg_notify($2, $3)', [key, channel, 'committed'])
        .then(
          () => 'resolved',
          (error: unknown) => error,
        );
      const elapsedMs = performance.now() - startedAt;
      await holder`SELECT pg_advisory_unlock(${key})`;
      // Time for a statement the server kept running to commit and notify.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Nothing committed once the lock cleared...
      expect(delivered).toEqual([]);
      // ...because the server cancelled it first, before the client deadline.
      expect(outcome).toMatchObject({ code: '57014' });
      expect(elapsedMs).toBeLessThan(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS);
    },
    WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS + 20_000,
  );
});
