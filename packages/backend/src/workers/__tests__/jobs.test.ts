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
import { BACKGROUND_JOB_QUEUES, BACKGROUND_JOB_QUEUE_OPTIONS } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import {
  claimBackgroundJobRun,
  withBackgroundJobAttempt,
  settleBackgroundJobRun,
  reconcileBackgroundJobRun,
} from '@boardsesh/db/queries';
import { enqueueOn } from '../../services/job-queue';
import { assertQueuePrimary, assertWorkerPrivileges } from '../../services/job-queue-client';
import {
  enqueueBackgroundJob,
  enqueueWorkerProbe,
  executeBackgroundJob,
  handlerForRole,
  type BackgroundJobHandler,
  type BackgroundJobPayload,
} from '../jobs';
import { BackgroundJobError, type BackgroundJobFamilyModule } from '../families';
import { workerProbeFamily } from '../families/worker-probe';

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
/** The probe family with its body swapped out, as the only family the handler knows. */
const probeHandlerWith = (execute: BackgroundJobFamilyModule['execute']): BackgroundJobHandler => ({
  ...handlerForRole(role),
  resolveFamily: (name) => (name === 'worker-probe' ? { ...workerProbeFamily, execute } : undefined),
});
const execute = async (handler: BackgroundJobHandler = handlerForRole(role)) =>
  executeBackgroundJob(database, boss, await fetch(), handler, new AbortController().signal);

beforeAll(async () => {
  // Local test-worker databases persist between runs. Apply the generated
  // migration when the fixture does not already contain its ledger table.
  const [existingLedger] = await owner`SELECT to_regclass('public.background_job_runs') AS ledger`;
  if (!existingLedger.ledger) {
    await owner.unsafe(
      readFileSync(new URL('../../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8'),
    );
  }
  const [familyColumn] = await owner`SELECT 1 AS present FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'background_job_runs' AND column_name = 'family'`;
  if (!familyColumn) {
    await owner.unsafe(
      readFileSync(new URL('../../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8'),
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

/**
 * Each child process (operator run, worker boot, worker settling a probe) gets
 * this long. A cold tsx start plus a 2 s poll interval fits in 5 s on an idle
 * box but not reliably under a full parallel backend suite in CI; polls return
 * as soon as they pass, so the happy path is no slower.
 */
const CHILD_PROCESS_BUDGET_MS = 15_000;

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
      probeHandlerWith(async () => {
        entered();
        await gate;
        if (throws) throw new Error('old handler failed');
      }),
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
        probeHandlerWith(async () => {
          throw new Error('private provider URL');
        }),
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

  it('records the family, payload and key on the run and applies the family options per job', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    expect(await run(id)).toMatchObject({ family: 'worker-probe', payload: {}, singletonKey: id, status: 'queued' });
    const deadlineMs = (await run(id)).deadlineAt.getTime() - Date.now();
    expect(deadlineMs).toBeGreaterThan(workerProbeFamily.options.deadlineSeconds * 1000 - 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(workerProbeFamily.options.deadlineSeconds * 1000);
    // The queue default differs, so this proves the per-job option won.
    expect(BACKGROUND_JOB_QUEUE_OPTIONS.expireInSeconds).not.toBe(workerProbeFamily.options.expireInSeconds);
    const [queueRow] = await owner`SELECT expire_seconds, policy FROM pgboss.queue WHERE name = ${queue}`;
    expect(queueRow).toMatchObject({ expire_seconds: BACKGROUND_JOB_QUEUE_OPTIONS.expireInSeconds, policy: 'stately' });
    const [jobRow] = await owner`SELECT expire_seconds, retry_limit, heartbeat_seconds, singleton_key, data
      FROM pgboss.job WHERE name = ${queue} AND id = ${id}`;
    expect(jobRow).toMatchObject({
      expire_seconds: workerProbeFamily.options.expireInSeconds,
      retry_limit: workerProbeFamily.options.retryLimit,
      heartbeat_seconds: workerProbeFamily.options.heartbeatSeconds,
      singleton_key: `worker-probe:${id}`,
      data: { runId: id },
    });
    expect(await execute()).toBe('succeeded');
    expect((await run(id)).status).toBe('succeeded');
  });

  it('returns the queued run for a duplicate singleton key and leaves exactly one run row', async () => {
    const enqueue = () =>
      enqueueBackgroundJob(database, boss, { role, family: 'worker-probe', payload: {}, singletonKey: 'board-7' });
    const first = await enqueue();
    expect(first.alreadyQueued).toBe(false);
    const [second, third] = await Promise.all([enqueue(), enqueue()]);
    expect(second).toEqual({ runId: first.runId, alreadyQueued: true });
    expect(third).toEqual({ runId: first.runId, alreadyQueued: true });
    const runs = await database
      .select()
      .from(backgroundJobRuns)
      .where(and(eq(backgroundJobRuns.family, 'worker-probe'), eq(backgroundJobRuns.singletonKey, 'board-7')));
    expect(runs.map((ledgerRun) => ledgerRun.id)).toEqual([first.runId]);
    const [{ jobs }] = await owner`SELECT count(*)::int AS jobs FROM pgboss.job WHERE name = ${queue}`;
    expect(jobs).toBe(1);
    // Once the holder is active, stately admits one more queued run for the key.
    const job = await fetch();
    expect(job.id).toBe(first.runId);
    const next = await enqueue();
    expect(next.alreadyQueued).toBe(false);
    expect(next.runId).not.toBe(first.runId);
  });

  it('gives a new run its own slot once the key holder is running', async () => {
    const enqueue = () =>
      enqueueBackgroundJob(database, boss, { role, family: 'worker-probe', payload: {}, singletonKey: 'board-9' });
    const first = await enqueue();
    expect((await fetch()).id).toBe(first.runId);
    const second = await enqueue();
    expect(second.alreadyQueued).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect((await run(second.runId)).status).toBe('queued');
  });

  it('retries once when the queued twin leaves between the dropped send and the lookup', async () => {
    const enqueue = () =>
      enqueueBackgroundJob(database, boss, { role, family: 'worker-probe', payload: {}, singletonKey: 'board-11' });
    // A dropped send with no queued holder: the twin was fetched in between.
    vi.spyOn(boss, 'send').mockResolvedValueOnce(null);
    const accepted = await enqueue();
    expect(accepted.alreadyQueued).toBe(false);
    expect((await run(accepted.runId)).status).toBe('queued');
    expect(await database.select().from(backgroundJobRuns)).toHaveLength(1);
  });

  it('returns the running holder when both tries are dropped without a queued holder', async () => {
    const enqueue = () =>
      enqueueBackgroundJob(database, boss, { role, family: 'worker-probe', payload: {}, singletonKey: 'board-12' });
    const first = await enqueue();
    expect((await fetch()).id).toBe(first.runId);
    vi.spyOn(boss, 'send').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await enqueue()).toEqual({ runId: first.runId, alreadyQueued: true });
    expect(await database.select().from(backgroundJobRuns)).toHaveLength(1);
  });

  it('rejects a payload the family schema refuses before anything is written', async () => {
    await expect(
      enqueueBackgroundJob(database, boss, { role, family: 'worker-probe', payload: { unexpected: true } }),
    ).rejects.toThrow('INVALID_PAYLOAD');
    await expect(enqueueBackgroundJob(database, boss, { role, family: 'no-such-family', payload: {} })).rejects.toThrow(
      'UNKNOWN_FAMILY',
    );
    expect(await database.select().from(backgroundJobRuns)).toHaveLength(0);
  });

  it.each([
    ['UNKNOWN_FAMILY', { family: 'retired-family' }],
    ['INVALID_PAYLOAD', { payload: { unexpected: true } }],
  ] as const)('fails a run with %s without retrying and keeps polling', async (errorCode, corruption) => {
    const id = await enqueueWorkerProbe(database, boss, role);
    await database.update(backgroundJobRuns).set(corruption).where(eq(backgroundJobRuns.id, id));
    expect(await execute()).toBe('failed');
    expect(await run(id)).toMatchObject({ status: 'failed', errorCode, attemptToken: null });
    expect((await boss.getJobById(queue, id))?.state).toBe('cancelled');
    // The next job on the same queue still runs.
    const nextId = await enqueueWorkerProbe(database, boss, role);
    expect(await execute()).toBe('succeeded');
    expect((await run(nextId)).status).toBe('succeeded');
  });

  it('records a family error code, retrying unless the family says otherwise', async () => {
    const retryableId = await enqueueWorkerProbe(database, boss, role);
    expect(
      await execute(
        probeHandlerWith(async () => {
          throw new BackgroundJobError('PROVIDER_UNAVAILABLE');
        }),
      ),
    ).toBe('failed');
    expect(await run(retryableId)).toMatchObject({ status: 'retrying', errorCode: 'PROVIDER_UNAVAILABLE' });
    await boss.deleteAllJobs(queue);
    const permanentId = await enqueueWorkerProbe(database, boss, role);
    expect(
      await execute(
        probeHandlerWith(async () => {
          throw new BackgroundJobError('CREDENTIAL_REVOKED', { retryable: false });
        }),
      ),
    ).toBe('failed');
    expect(await run(permanentId)).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL_REVOKED' });
    expect(() => new BackgroundJobError('https://user:secret@example.com')).toThrow('INVALID_ERROR_CODE');
  });

  it('hands execute the run, family, an unfenced reader and the validated payload', async () => {
    const id = await enqueueWorkerProbe(database, boss, role);
    const seen: unknown[] = [];
    expect(
      await execute(
        probeHandlerWith(async (context, payload) => {
          seen.push(context.runId, context.family, payload);
          const [ledgerRun] = await context.database
            .select({ status: backgroundJobRuns.status })
            .from(backgroundJobRuns)
            .where(eq(backgroundJobRuns.id, context.runId));
          seen.push(ledgerRun.status);
        }),
      ),
    ).toBe('succeeded');
    expect(seen).toEqual([id, 'worker-probe', {}, 'running']);
  });

  it('rejects the backend runtime login even though it has no DDL privileges', async () => {
    // Mirrors migration-runtime-acl.ts: CRUD on every application table, pg-boss
    // DML, USAGE but no CREATE on the schemas. Every earlier privilege bit matches
    // a worker, so only the broad application grants can fail this login closed.
    const roleName = `runtime_test_${randomUUID().replaceAll('-', '')}`;
    try {
      await owner.unsafe(`CREATE ROLE "${roleName}" NOLOGIN`);
      await owner.unsafe(`GRANT USAGE ON SCHEMA public, pgboss TO "${roleName}"`);
      await owner.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO "${roleName}"`,
      );
      await owner.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE "${roleName}"`);
        const asRuntime = {
          executeSql: async (statement: string, parameters?: unknown[]) => ({
            rows: [...(await transaction.unsafe(statement, (parameters ?? []) as never))],
          }),
        };
        await expect(assertWorkerPrivileges(asRuntime)).rejects.toThrow('restricted');
      });
    } finally {
      await owner.unsafe(`DROP OWNED BY "${roleName}"`);
      await owner.unsafe(`DROP ROLE "${roleName}"`);
    }
  });

  it(
    'boots and settles under worker grants without DDL or personal data privileges',
    async () => {
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
            [
              '--import',
              'tsx',
              fileURLToPath(new URL('../operator.ts', import.meta.url)),
              'enqueue',
              'worker-probe',
              '{}',
              '--id',
              operatorRunId,
            ],
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
              timeout: CHILD_PROCESS_BUDGET_MS,
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
        await expect
          .poll(health, { timeout: CHILD_PROCESS_BUDGET_MS })
          .toMatchObject({ ready: true, paused: true, role });
        const probeId = await enqueueWorkerProbe(database, boss, role);
        expect((await run(probeId)).status).toBe('queued');
        await stopChild();
        startChild(false);
        await expect
          .poll(async () => (await run(probeId)).status, { timeout: CHILD_PROCESS_BUDGET_MS })
          .toBe('succeeded');
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
    },
    6 * CHILD_PROCESS_BUDGET_MS,
  );
});
