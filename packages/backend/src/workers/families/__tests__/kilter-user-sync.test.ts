import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KilterCredentialRecord, RunCycleOptions, RunnerDb, SyncOutcome } from '@boardsesh/kilter-sync/runner';

// The Kilter provider (Keycloak, PowerSync) is replaced by a runner whose cycle
// the test scripts; the fences, lease and ledger around it are real.
const cycle = vi.hoisted(() => ({
  run: vi.fn<(db: RunnerDb, cred: KilterCredentialRecord, options: RunCycleOptions) => Promise<SyncOutcome>>(),
}));
vi.mock('@boardsesh/kilter-sync/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/kilter-sync/runner')>()),
  SyncRunner: class {
    runCycleForCredential(db: RunnerDb, cred: KilterCredentialRecord, options: RunCycleOptions) {
      return cycle.run(db, cred, options);
    }
  },
}));

import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { rotateLinkGeneration } from '@boardsesh/db/queries';
import { enqueueBackgroundJob, executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../../jobs';
import { ensureBackgroundJobSchema } from './provider-sync-fixtures';

const role = 'interactive-import' as const;
const queue = BACKGROUND_JOB_QUEUES[role];
const USER_ID = 'psync-kilter-user';
const key = { userId: USER_ID, boardType: 'kilter' };
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

const controlRow = async () =>
  (
    await database
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, 'kilter')))
  )[0];
const runRow = async (runId: string) =>
  (await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId)))[0];

async function linkKilter(): Promise<string> {
  await database.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Kilter Tester', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await database
    .insert(auroraCredentials)
    .values({ userId: USER_ID, boardType: 'kilter', encryptedRefreshToken: 'ciphertext', syncStatus: 'pending' });
  const { linkGeneration } = await database.transaction((transaction) =>
    rotateLinkGeneration(transaction, { ...key, linked: true }),
  );
  return linkGeneration;
}

async function enqueueAndExecute(linkGeneration: string) {
  const { runId } = await enqueueBackgroundJob(database, boss, {
    family: 'kilter-user-sync',
    payload: { ...key, linkGeneration, requestedBy: 'link' },
  });
  await database
    .update(providerSyncControls)
    .set({ pendingRunId: runId })
    .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, 'kilter')));
  const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  const result = await executeBackgroundJob(database, boss, job, handlerForRole(role), new AbortController().signal);
  return { runId, result };
}

/** What the real cycle's success write looks like, routed through the fenced runner it was handed. */
async function markActive(options: RunCycleOptions) {
  await options.transaction!(async (transaction) => {
    await transaction
      .update(auroraCredentials)
      .set({ syncStatus: 'active', lastSyncAt: new Date() })
      .where(and(eq(auroraCredentials.userId, USER_ID), eq(auroraCredentials.boardType, 'kilter')));
  });
}

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
  await boss.start();
});
beforeEach(async () => {
  cycle.run.mockReset();
  await boss.deleteAllJobs(queue);
  await database.delete(backgroundJobRuns);
  await database.execute(sql`DELETE FROM aurora_credentials WHERE user_id = ${USER_ID}`);
  await database.execute(sql`DELETE FROM provider_sync_controls WHERE user_id = ${USER_ID}`);
});
afterAll(async () => {
  await database.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('kilter-user-sync', () => {
  it('runs one fenced cycle without the catalog piggyback and clears the lease and pending run', async () => {
    const linkGeneration = await linkKilter();
    cycle.run.mockImplementation(async (_db, cred, options) => {
      expect(cred.userId).toBe(USER_ID);
      expect(options.skipCatalogSync).toBe(true);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      await markActive(options);
      return { status: 'active' };
    });

    const { runId, result } = await enqueueAndExecute(linkGeneration);

    expect(result).toBe('succeeded');
    expect((await runRow(runId)).status).toBe('succeeded');
    expect(await controlRow()).toMatchObject({ activeRunId: null, pendingRunId: null });
    const [credential] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, USER_ID));
    expect(credential.syncStatus).toBe('active');
  });

  it('never starts a cycle for a run queued before a relink', async () => {
    const linkGeneration = await linkKilter();
    await database.transaction((transaction) => rotateLinkGeneration(transaction, { ...key, linked: true }));

    const { runId, result } = await enqueueAndExecute(linkGeneration);

    expect(result).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed', errorCode: 'STALE_LINK_GENERATION' });
    expect(cycle.run).not.toHaveBeenCalled();
  });

  it('rolls back a write once another run has taken the lease', async () => {
    const linkGeneration = await linkKilter();
    cycle.run.mockImplementation(async (_db, _cred, options) => {
      // A different run takes over the lease mid-cycle (ours expired while a
      // long stream ran); our next batch must not commit.
      await database
        .update(providerSyncControls)
        .set({ activeRunId: randomUUID(), activeLeaseUntil: new Date(Date.now() + 60_000) })
        .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, 'kilter')));
      await markActive(options);
      return { status: 'active' };
    });

    const { runId, result } = await enqueueAndExecute(linkGeneration);

    expect(result).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'retrying', errorCode: 'CREDENTIAL_BUSY' });
    const [credential] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, USER_ID));
    expect(credential.syncStatus).toBe('pending');
  });

  it('retries a transient provider failure and keeps the pending run for it', async () => {
    const linkGeneration = await linkKilter();
    cycle.run.mockResolvedValue({ status: 'error', error: 'keycloak timed out', transient: true });

    const { runId, result } = await enqueueAndExecute(linkGeneration);

    expect(result).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'retrying', errorCode: 'PROVIDER_UNAVAILABLE' });
    expect(await controlRow()).toMatchObject({ activeRunId: null, pendingRunId: runId });
  });

  it('ends the run on an expired credential and clears the pending run', async () => {
    const linkGeneration = await linkKilter();
    cycle.run.mockResolvedValue({ status: 'expired', error: 'invalid_grant', transient: false });

    const { runId, result } = await enqueueAndExecute(linkGeneration);

    expect(result).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL_EXPIRED' });
    expect(await controlRow()).toMatchObject({ activeRunId: null, pendingRunId: null });
  });
});
