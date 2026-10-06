process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/aurora-sync/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/aurora-sync/api')>()),
  AuroraClimbingClient: class {
    signIn = signInMock;
  },
}));

const revokeMock = vi.hoisted(() => {
  // Read once at import by the credential service; set so an unlink revokes.
  process.env.KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID ?? 'enqueue-test-client';
  return vi.fn(async (_refreshToken: string) => {});
});
vi.mock('@boardsesh/kilter-sync/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/kilter-sync/api')>()),
  revokeRefreshToken: (refreshToken: string) => revokeMock(refreshToken),
}));

// The producer enqueues on the backend's pg-boss; point it at this file's instance.
const queueHolder = vi.hoisted(() => ({ boss: null as PgBoss | null }));
vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  requireJobQueue: () => {
    if (!queueHolder.boss) throw new Error('test queue not started');
    return queueHolder.boss;
  },
}));

// Wrapped so one test can make the step right after the enqueue fail.
const setPendingFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    setPendingProviderSyncRun: async (...args: Parameters<typeof actual.setPendingProviderSyncRun>) => {
      const failure = setPendingFailure.next;
      setPendingFailure.next = null;
      if (failure) throw failure;
      return actual.setPendingProviderSyncRun(...args);
    },
  };
});

import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  deleteAuroraCredential,
  getAuroraCredentialStatuses,
  saveAuroraCredential,
  saveKilterCredential,
} from '../services/aurora-credentials';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../workers/jobs';
import { ensureBackgroundJobSchema } from '../workers/families/__tests__/provider-sync-fixtures';

const role = 'interactive-import' as const;
const queue = BACKGROUND_JOB_QUEUES[role];
const USER_ID = 'psync-producer-user';
const database = createDb();
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
boss.on('error', () => {});

const controlRow = async (boardType = 'tension') =>
  (
    await db
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, boardType)))
  )[0];
const runs = () => db.select().from(backgroundJobRuns);
const queuedJobs = async () => (await boss.findJobs(queue, { queued: true })).map((job) => job.id);
const link = (password = 'pw') =>
  saveAuroraCredential({ userId: USER_ID, boardType: 'tension', username: 'climber', password });

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
  await boss.start();
  queueHolder.boss = boss;
});
beforeEach(async () => {
  signInMock.mockReset();
  signInMock.mockResolvedValue({ token: 'aurora-token', user_id: 777001 });
  setPendingFailure.next = null;
  await boss.deleteAllJobs(queue);
  await db.delete(backgroundJobRuns);
  await db.execute(sql`DELETE FROM aurora_credentials WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM user_board_mappings WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM provider_sync_controls WHERE user_id = ${USER_ID}`);
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Producer Tester', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
});
afterEach(() => {
  delete process.env.BATCH_FAMILIES_DISABLED;
});
afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('linking a board queues its first sync', () => {
  it('commits one run with the link, fenced on the new generation, as the pending run', async () => {
    const status = await link();

    expect(status.syncRunId).toBeDefined();
    expect(status.pendingRunId).toBe(status.syncRunId);
    expect(status.syncAvailable).toBe(true);
    const control = await controlRow();
    const [run] = await runs();
    expect(await runs()).toHaveLength(1);
    expect(run).toMatchObject({
      id: status.syncRunId,
      family: 'aurora-user-sync',
      role,
      status: 'queued',
      payload: { userId: USER_ID, boardType: 'tension', linkGeneration: control.linkGeneration, requestedBy: 'link' },
    });
    expect(control).toMatchObject({ linked: true, pendingRunId: status.syncRunId });
    expect(await queuedJobs()).toEqual([status.syncRunId]);
  });

  it('leaves neither the credential nor the run behind when the link fails after the enqueue', async () => {
    setPendingFailure.next = new Error('simulated failure after enqueue');

    await expect(link()).rejects.toThrow('simulated failure after enqueue');

    expect(await db.select().from(auroraCredentials).where(eq(auroraCredentials.userId, USER_ID))).toEqual([]);
    expect(await controlRow()).toBeUndefined();
    expect(await runs()).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
  });

  it('gives a relink its own run and fails the old one at its first fenced batch', async () => {
    const first = await link('pw1');
    const second = await link('pw2');

    expect(second.syncRunId).not.toBe(first.syncRunId);
    expect((await controlRow()).pendingRunId).toBe(second.syncRunId);
    const jobs = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 2 });
    const oldJob = jobs.find((job) => job.id === first.syncRunId);
    expect(oldJob).toBeDefined();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(
      await executeBackgroundJob(database, boss, oldJob!, handlerForRole(role), new AbortController().signal),
    ).toBe('failed');

    const [oldRun] = await db.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, first.syncRunId!));
    expect(oldRun).toMatchObject({ status: 'failed', errorCode: 'STALE_LINK_GENERATION' });
    // It stopped before any provider call, and the new link's pending run is untouched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await controlRow()).pendingRunId).toBe(second.syncRunId);
    fetchSpy.mockRestore();
  });

  it('a relink through either saver ends a provider Retry-After hold', async () => {
    process.env.BATCH_FAMILIES_DISABLED = 'aurora-user-sync,kilter-user-sync';
    const holdOf = async (boardType: string) =>
      (
        await db
          .select({ until: auroraCredentials.providerRetryAfterUntil })
          .from(auroraCredentials)
          .where(and(eq(auroraCredentials.userId, USER_ID), eq(auroraCredentials.boardType, boardType)))
      )[0].until;
    const hold = (boardType: string) =>
      db
        .update(auroraCredentials)
        .set({ providerRetryAfterUntil: new Date(Date.now() + 5 * 60 * 60 * 1000) })
        .where(and(eq(auroraCredentials.userId, USER_ID), eq(auroraCredentials.boardType, boardType)));

    await link('pw1');
    await hold('tension');
    await link('pw2');
    expect(await holdOf('tension')).toBeNull();

    await saveKilterCredential({ userId: USER_ID, refreshToken: 'refresh-1', kilterUserId: 'kc-sub-1' });
    await hold('kilter');
    await saveKilterCredential({ userId: USER_ID, refreshToken: 'refresh-2', kilterUserId: 'kc-sub-1' });
    expect(await holdOf('kilter')).toBeNull();
  });

  it('queues nothing while the family is switched off, but still records the link generation', async () => {
    process.env.BATCH_FAMILIES_DISABLED = 'aurora-user-sync';
    const status = await link();

    expect(status.syncRunId).toBeUndefined();
    expect(status.pendingRunId).toBeNull();
    expect(status.syncAvailable).toBe(false);
    expect(await runs()).toEqual([]);
    expect(await controlRow()).toMatchObject({ linked: true, pendingRunId: null });
  });

  it('still links, queueing nothing, when BATCH_FAMILIES_DISABLED has a typo', async () => {
    process.env.BATCH_FAMILIES_DISABLED = 'aurora-usr-sync';

    const status = await link();

    expect(status.syncRunId).toBeUndefined();
    expect(status.syncAvailable).toBe(false);
    expect(await runs()).toEqual([]);
    expect(await controlRow()).toMatchObject({ linked: true, pendingRunId: null });
    const [listed] = await getAuroraCredentialStatuses(USER_ID);
    expect(listed).toMatchObject({ boardType: 'tension', syncAvailable: false });
  });

  it('queues a kilter-user-sync run for a Kilter link and marks the row unlinked on unlink', async () => {
    const result = await saveKilterCredential({ userId: USER_ID, refreshToken: 'refresh', kilterUserId: 'kc-sub-1' });

    const [run] = await runs();
    expect(run).toMatchObject({ id: result.syncRunId, family: 'kilter-user-sync' });
    const linkedGeneration = (await controlRow('kilter')).linkGeneration;

    // The revocation is HTTP: it must run after the unlink committed, with no
    // row lock held. Read from another connection while it "runs".
    let credentialsDuringRevoke: number | null = null;
    revokeMock.mockImplementationOnce(async () => {
      const rows = await owner`SELECT 1 FROM aurora_credentials WHERE user_id = ${USER_ID} AND board_type = 'kilter'`;
      credentialsDuringRevoke = rows.length;
    });

    expect(await deleteAuroraCredential(USER_ID, 'kilter')).toEqual({ success: true });

    expect(revokeMock).toHaveBeenCalledWith('refresh');
    expect(credentialsDuringRevoke).toBe(0);

    const control = await controlRow('kilter');
    expect(control).toMatchObject({ linked: false, pendingRunId: null });
    expect(control.linkGeneration).not.toBe(linkedGeneration);
  });
});
