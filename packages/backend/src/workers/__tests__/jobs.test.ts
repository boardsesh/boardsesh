import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createDb } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import {
  claimBackgroundJobRun,
  withBackgroundJobAttempt,
  settleBackgroundJobRun,
  reconcileBackgroundJobRun,
} from '@boardsesh/db/queries';
import { enqueueOn } from '../../services/job-queue';
import { assertQueuePrimary, assertWorkerPrivileges } from '../../services/job-queue-client';
import { enqueueWorkerProbe, executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../jobs';

const role = 'interactive-import' as const;
const queue = BACKGROUND_JOB_QUEUES[role];
const database = createDb();
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
boss.on('error', () => {});
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const run = async (id: string) =>
  (await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, id)))[0];
const fetch = async () => (await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 }))[0];

beforeAll(async () => {
  // Local test-worker databases persist between runs. Apply the generated
  // migration when the fixture does not already contain its ledger table.
  const [existingLedger] = await owner`SELECT to_regclass('public.background_job_runs') AS ledger`;
  if (!existingLedger.ledger) {
    await owner.unsafe(
      readFileSync(new URL('../../../../db/drizzle/0237_background_job_runs.sql', import.meta.url), 'utf8'),
    );
  }
  await initializeJobQueueSchema(drizzle(owner));
  await boss.start();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await boss.deleteAllJobs(queue);
  await database.delete(backgroundJobRuns);
});
afterAll(async () => {
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('durable worker jobs', () => {
  it('atomically enqueues one ID-only job and preserves idempotency after lost acknowledgement', async () => {
    const id = randomUUID();
    await Promise.all([enqueueWorkerProbe(database, boss, role, id), enqueueWorkerProbe(database, boss, role, id)]);
    expect((await boss.getJobById(queue, id))?.data).toEqual({ runId: id });
    expect((await run(id)).status).toBe('queued');
    const failedId = randomUUID();
    vi.spyOn(boss, 'send').mockRejectedValueOnce(new Error('simulated enqueue failure'));
    await expect(enqueueWorkerProbe(database, boss, role, failedId)).rejects.toThrow();
    expect(await run(failedId)).toBeUndefined();
  });

  it('allows only one claimant and rolls back a batch whose deadline expires', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    const job = await fetch();
    const claims = await Promise.all([
      claimBackgroundJobRun(database, id, queue, job.retryCount),
      claimBackgroundJobRun(database, id, queue, job.retryCount),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const token = claims.find((claim): claim is string => claim !== null)!;
    await expect(
      withBackgroundJobAttempt(database, id, token, async (transaction) => {
        await transaction
          .update(backgroundJobRuns)
          .set({ errorCode: 'SHOULD_ROLL_BACK', deadlineAt: new Date(0) })
          .where(eq(backgroundJobRuns.id, id));
      }),
    ).rejects.toThrow('no longer current');
    expect((await run(id)).errorCode).toBeNull();
  });

  it('commits the ledger and queue completion in one transaction', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    expect(
      await executeBackgroundJob(database, boss, await fetch(), handlerForRole(role), new AbortController().signal),
    ).toBe('succeeded');
    expect((await run(id)).status).toBe('succeeded');
    expect((await boss.getJobById(queue, id))?.state).toBe('completed');
  });

  it('rolls back queue completion when settlement fails before commit', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    const job = await fetch();
    const token = (await claimBackgroundJobRun(database, id, queue, job.retryCount))!;
    await expect(
      settleBackgroundJobRun(database, id, token, async (transaction) => {
        await boss.complete(queue, id, undefined, { db: enqueueOn(transaction) });
        throw new Error('commit interrupted');
      }),
    ).rejects.toThrow('commit interrupted');
    expect((await run(id)).status).toBe('running');
    expect((await boss.getJobById(queue, id))?.state).toBe('active');
  });

  it.each([false, true])('a stale handler cannot settle a newer attempt (throws=%s)', async (throws) => {
    const id = await enqueueWorkerProbe(database, boss, role);
    const first = await fetch();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oldAttempt = executeBackgroundJob(
      database,
      boss,
      first,
      {
        ...handlerForRole(role),
        execute: async () => {
          entered();
          await gate;
          if (throws) throw new Error('old handler failed');
        },
      },
      new AbortController().signal,
    );
    await handlerEntered;
    try {
      // Simulate supervisor reclaim, then make retry immediately eligible without sleeping.
      await boss.fail(queue, id);
      await owner`UPDATE pgboss.job SET start_after = now() WHERE name = ${queue} AND id = ${id}`;
      const retry = await fetch();
      expect(retry.retryCount).toBe(first.retryCount + 1);
      const currentToken = await claimBackgroundJobRun(database, id, queue, retry.retryCount);
      expect(currentToken).toBeTruthy();
      release();
      expect(await oldAttempt).toBe('stale');
      expect(await run(id)).toMatchObject({
        status: 'running',
        attemptToken: currentToken,
        attemptNumber: retry.retryCount,
      });
      expect(await boss.getJobById(queue, id)).toMatchObject({ state: 'active', retryCount: retry.retryCount });
      // A late duplicate fetch result must not acknowledge the replacement either.
      expect(
        await executeBackgroundJob(database, boss, first, handlerForRole(role), new AbortController().signal),
      ).toBe('stale');
      expect((await boss.getJobById(queue, id))?.state).toBe('active');
    } finally {
      release();
      await oldAttempt;
    }
  });

  it('persists retry state and reclaims an expired attempt without homelab consumers', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    const first = await fetch();
    expect(
      await executeBackgroundJob(
        database,
        boss,
        first,
        {
          ...handlerForRole(role),
          execute: async () => {
            throw new Error('private provider URL');
          },
        },
        new AbortController().signal,
      ),
    ).toBe('failed');
    expect((await run(id)).status).toBe('retrying');
    expect(JSON.stringify((await boss.getJobById(queue, id))?.output)).not.toContain('private provider URL');
    await owner`UPDATE pgboss.job SET start_after = now() WHERE name = ${queue} AND id = ${id}`;
    const retry = await fetch();
    await claimBackgroundJobRun(database, id, queue, retry.retryCount);
    await owner`UPDATE pgboss.job SET heartbeat_on = now() - interval '1 hour' WHERE name = ${queue} AND id = ${id}`;
    expect(await reconcileBackgroundJobRun(database, id)).toBe(true);
    expect(await run(id)).toMatchObject({ status: 'retrying', attemptToken: null, errorCode: 'ATTEMPT_EXPIRED' });
  });

  it.each(['missing', 'failed', 'cancelled', 'expired'] as const)(
    'reconciles %s jobs independently of workers',
    async (state) => {
      const id = await enqueueWorkerProbe(database, boss, role);
      if (state === 'missing') await boss.deleteJob(queue, id);
      if (state === 'failed') await owner`UPDATE pgboss.job SET state = 'failed' WHERE name = ${queue} AND id = ${id}`;
      if (state === 'cancelled') await boss.cancel(queue, id);
      if (state === 'expired')
        await database
          .update(backgroundJobRuns)
          .set({ deadlineAt: new Date(0) })
          .where(eq(backgroundJobRuns.id, id));
      expect(await reconcileBackgroundJobRun(database, id)).toBe(true);
      expect((await run(id)).status).toBe(state === 'cancelled' ? 'cancelled' : 'failed');
    },
  );

  it('boots and settles under worker grants without DDL or personal data privileges', async () => {
    const roleName = `worker_test_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    let child: ChildProcess | undefined;
    const stopChild = async () => {
      if (!child || child.exitCode !== null) return;
      const running = child;
      const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()));
      running.kill('SIGTERM');
      const force = setTimeout(() => running.kill('SIGKILL'), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
        child = undefined;
      }
    };
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.searchParams.set('options', `-c role=${roleName}`);
    const restricted = new PgBoss({
      connectionString: workerUrl.toString(),
      max: 1,
      migrate: false,
      schedule: false,
      supervise: false,
    });
    restricted.on('error', () => {});
    try {
      await owner.unsafe(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
      await initializeJobQueueSchema(drizzle(owner), undefined, undefined, [roleName]);
      await restricted.start();
      await assertQueuePrimary(restricted.getDb());
      await assertWorkerPrivileges(restricted.getDb());
      await expect(restricted.getDb().executeSql('CREATE TABLE public.worker_forbidden (id int)')).rejects.toThrow(
        'permission denied',
      );
      await expect(restricted.getDb().executeSql('SELECT * FROM public.users LIMIT 1')).rejects.toThrow(
        'permission denied',
      );
      const id = await enqueueWorkerProbe(database, boss, role);
      const [job] = await restricted.fetch<BackgroundJobPayload>(queue, { includeMetadata: true });
      expect(job.id).toBe(id);
      // Restricted-role transactions, including pg-boss settlement, share the same connection.
      await database.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`SET LOCAL ROLE "${roleName}"`));
        expect(
          await transaction
            .select()
            .from(backgroundJobRuns)
            .where(and(eq(backgroundJobRuns.id, id), eq(backgroundJobRuns.role, role))),
        ).toHaveLength(1);
      });
      await expect(assertWorkerPrivileges(boss.getDb())).rejects.toThrow('restricted');
      const socket = createServer();
      await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
      const address = socket.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const loginUrl = new URL(process.env.DATABASE_URL!);
      loginUrl.username = roleName;
      loginUrl.password = password;
      const operatorRunId = randomUUID();
      const invokeOperator = (connectionUrl: string) =>
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(new URL('../operator.ts', import.meta.url)), 'enqueue', operatorRunId],
          {
            cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
            env: {
              ...process.env,
              DATABASE_URL: connectionUrl,
              WORKER_ROLE: role,
              WORKER_OPERATOR_ENABLED: 'true',
              DB_POOL_MAX: '2',
              PGBOSS_POOL_SIZE: '1',
              READ_REPLICA_URL: '',
            },
            timeout: 5000,
          },
        );
      await expect(invokeOperator(process.env.DATABASE_URL!)).rejects.toMatchObject({ code: 1 });
      expect(await run(operatorRunId)).toBeUndefined();
      expect(await boss.getJobById(queue, operatorRunId)).toBeNull();
      await invokeOperator(loginUrl.toString());
      expect((await run(operatorRunId)).status).toBe('queued');
      expect((await boss.getJobById(queue, operatorRunId))?.data).toEqual({ runId: operatorRunId });
      const startChild = (paused: boolean) => {
        child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url))], {
          cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
          env: {
            ...process.env,
            DATABASE_URL: loginUrl.toString(),
            WORKER_ROLE: role,
            WORKER_PAUSED: String(paused),
            HEALTH_PORT: String(address.port),
            DB_POOL_MAX: '2',
            PGBOSS_POOL_SIZE: '1',
            READ_REPLICA_URL: '',
          },
          stdio: 'ignore',
        });
      };
      const health = async () => {
        try {
          return await (await globalThis.fetch(`http://127.0.0.1:${address.port}/health`)).json();
        } catch {
          return null;
        }
      };
      startChild(true);
      await expect.poll(health, { timeout: 5000 }).toMatchObject({ ready: true, paused: true, role });
      const probeId = await enqueueWorkerProbe(database, boss, role);
      expect((await run(probeId)).status).toBe('queued');
      await stopChild();
      startChild(false);
      await expect.poll(async () => (await run(probeId)).status, { timeout: 5000 }).toBe('succeeded');
      expect((await boss.getJobById(queue, probeId))?.state).toBe('completed');
      const [connections] =
        await owner`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = ${roleName}`;
      expect(connections.count).toBeLessThanOrEqual(3);
    } finally {
      await stopChild();
      await restricted.stop({ graceful: true, close: true });
      await owner.unsafe(`DROP OWNED BY "${roleName}"`);
      await owner.unsafe(`DROP ROLE "${roleName}"`);
    }
  }, 20_000);
});
