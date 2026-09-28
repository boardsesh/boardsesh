process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { acquireCredentialSyncLease, rotateLinkGeneration } from '@boardsesh/db/queries';
import { enqueueBackgroundJob, executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../../jobs';
import {
  AURORA_USER_ID,
  FIXTURE_BOARD,
  ascentRow,
  ensureBackgroundJobSchema,
  fullSyncPage,
  insertLinkedTensionAccount,
  removeFixtures,
  stubAuroraApi,
} from './provider-sync-fixtures';

const role = 'interactive-import' as const;
const queue = BACKGROUND_JOB_QUEUES[role];
const USER_ID = 'psync-aurora-user';
const CLIMB_UUID = 'psync-climb-aurora';
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

async function enqueueSync(linkGeneration: string, requestedBy: 'link' | 'manual' = 'link') {
  const { runId } = await enqueueBackgroundJob(database, boss, {
    family: 'aurora-user-sync',
    payload: { userId: USER_ID, boardType: FIXTURE_BOARD, linkGeneration, requestedBy },
  });
  await database
    .update(providerSyncControls)
    .set({ pendingRunId: runId })
    .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, FIXTURE_BOARD)));
  return runId;
}

async function executeNext(signal = new AbortController().signal) {
  const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  expect(job).toBeDefined();
  return executeBackgroundJob(database, boss, job, handlerForRole(role), signal);
}

const runRow = async (runId: string) =>
  (await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId)))[0];
const controlRow = async () =>
  (
    await database
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, FIXTURE_BOARD)))
  )[0];
const credentialRow = async () =>
  (
    await database
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, USER_ID), eq(auroraCredentials.boardType, FIXTURE_BOARD)))
  )[0];
const tickAuroraIds = async () =>
  (
    await database.execute<{ aurora_id: string }>(
      sql`SELECT aurora_id FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id`,
    )
  ).map((row) => row.aurora_id);

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
  await boss.start();
});
beforeEach(async () => {
  await boss.deleteAllJobs(queue);
  await database.delete(backgroundJobRuns);
  await removeFixtures(database, [USER_ID], [CLIMB_UUID]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await removeFixtures(database, [USER_ID], [CLIMB_UUID]);
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('aurora-user-sync', () => {
  it('queues its own follow-up for when Aurora said on a 429, and ends without a pg-boss retry', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/sessions')) {
          return new Response(JSON.stringify({ session: { token: 'aurora-session-token', user_id: AURORA_USER_ID } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/sync'))
          return new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } });
        throw new Error(`Unexpected request in test: ${url}`);
      }),
    );
    const runId = await enqueueSync(linkGeneration, 'manual');

    expect(await executeNext()).toBe('succeeded');

    // This run is settled; its pg-boss job is completed, not waiting to retry.
    expect((await runRow(runId)).status).toBe('succeeded');
    expect((await boss.getJobById(queue, runId))?.state).toBe('completed');
    // One follow-up, same payload, held for about an hour, now the pending run.
    const followUps = (await database.select().from(backgroundJobRuns)).filter((run) => run.id !== runId);
    expect(followUps).toHaveLength(1);
    const [followUp] = followUps;
    expect(followUp).toMatchObject({
      family: 'aurora-user-sync',
      status: 'queued',
      payload: { userId: USER_ID, boardType: FIXTURE_BOARD, linkGeneration, requestedBy: 'manual' },
    });
    const job = await boss.getJobById(queue, followUp.id);
    expect(job?.state).toBe('created');
    const heldForMs = new Date(job!.startAfter).getTime() - Date.now();
    expect(heldForMs).toBeGreaterThan(3600_000 - 60_000);
    expect(heldForMs).toBeLessThanOrEqual(3600_000 + 5_000);
    // Its deadline counts from when it may start.
    expect(followUp.deadlineAt.getTime() - Date.now()).toBeGreaterThan(3600_000);
    expect((await controlRow()).pendingRunId).toBe(followUp.id);
    // The routine claim honours the same hold, and the 429 costs no backoff step.
    const credential = await credentialRow();
    const heldUntilMs = credential.providerRetryAfterUntil!.getTime() - Date.now();
    expect(heldUntilMs).toBeGreaterThan(3600_000 - 60_000);
    expect(heldUntilMs).toBeLessThanOrEqual(3600_000 + 5_000);
    expect(credential.consecutiveFailures).toBe(0);
    // Nothing is fetchable before then.
    expect(await boss.fetch(queue, { batchSize: 1 })).toEqual([]);
  });

  it('syncs every page, marks the credential active and clears the lease and pending run', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    // A routine cycle's Retry-After hold, still running: a "Sync now" that goes
    // through must end it, or the routine claim skips the account for hours.
    await database.execute(sql`
      UPDATE aurora_credentials SET provider_retry_after_until = now() + interval '5 hours'
       WHERE user_id = ${USER_ID} AND board_type = ${FIXTURE_BOARD}`);
    const aurora = stubAuroraApi({ pages: [fullSyncPage(CLIMB_UUID)] });
    const runId = await enqueueSync(linkGeneration);

    expect(await executeNext()).toBe('succeeded');

    expect(aurora.requests).toEqual(['login', 'sync']);
    expect((await runRow(runId)).status).toBe('succeeded');
    expect(await tickAuroraIds()).toEqual(['psync-ascent-1', 'psync-bid-1']);
    const credential = await credentialRow();
    expect(credential.syncStatus).toBe('active');
    expect(credential.lastSyncAt).toBeInstanceOf(Date);
    expect(credential.consecutiveFailures).toBe(0);
    expect(credential.providerRetryAfterUntil).toBeNull();
    const control = await controlRow();
    expect(control).toMatchObject({ activeRunId: null, activeLeaseUntil: null, pendingRunId: null });
  });

  it('fails a run queued for an older link without calling Aurora or writing anything', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const aurora = stubAuroraApi({ pages: [fullSyncPage(CLIMB_UUID)] });
    const runId = await enqueueSync(linkGeneration);
    // The climber relinks before a worker picks the run up.
    await database.transaction((transaction) =>
      rotateLinkGeneration(transaction, { userId: USER_ID, boardType: FIXTURE_BOARD, linked: true }),
    );

    expect(await executeNext()).toBe('failed');

    expect(await runRow(runId)).toMatchObject({ status: 'failed', errorCode: 'STALE_LINK_GENERATION' });
    // Non-retryable: pg-boss cancelled the job instead of spending retries on it.
    expect((await boss.getJobById(queue, runId))?.state).toBe('cancelled');
    expect(aurora.fetchMock).not.toHaveBeenCalled();
    expect(await tickAuroraIds()).toEqual([]);
  });

  it('rolls back the batch that meets a relink mid-run and records nothing on the credential', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const tokenBefore = (await credentialRow()).auroraToken;
    // Relink while the login request is in flight: the first fenced write (the
    // new session token) must see the new generation and roll back.
    stubAuroraApi({
      pages: [fullSyncPage(CLIMB_UUID)],
      onRequest: async (kind) => {
        if (kind !== 'login') return;
        await database.transaction((transaction) =>
          rotateLinkGeneration(transaction, { userId: USER_ID, boardType: FIXTURE_BOARD, linked: true }),
        );
      },
    });
    const runId = await enqueueSync(linkGeneration);

    expect(await executeNext()).toBe('failed');

    expect(await runRow(runId)).toMatchObject({ status: 'failed', errorCode: 'STALE_LINK_GENERATION' });
    const credential = await credentialRow();
    expect(credential.auroraToken).toBe(tokenBefore);
    expect(credential.consecutiveFailures).toBe(0);
    expect(credential.lastSyncError).toBeNull();
    expect(await tickAuroraIds()).toEqual([]);
  });

  it('backs off with CREDENTIAL_BUSY while another run holds the lease, and flags a manual requester', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const aurora = stubAuroraApi({ pages: [fullSyncPage(CLIMB_UUID)] });
    // A routine sync holds a live lease on this credential.
    const routineRunId = randomUUID();
    expect(
      await database.transaction((transaction) =>
        acquireCredentialSyncLease(transaction, {
          userId: USER_ID,
          boardType: FIXTURE_BOARD,
          runId: routineRunId,
          ttlMs: 60_000,
        }),
      ),
    ).toBe(true);
    const runId = await enqueueSync(linkGeneration, 'manual');

    expect(await executeNext()).toBe('failed');

    expect(await runRow(runId)).toMatchObject({ status: 'retrying', errorCode: 'CREDENTIAL_BUSY' });
    const control = await controlRow();
    expect(control.notifyRequester).toBe(true);
    // The lease still belongs to the routine run, and the pending run stays for the retry.
    expect(control.activeRunId).toBe(routineRunId);
    expect(control.pendingRunId).toBe(runId);
    expect(aurora.fetchMock).not.toHaveBeenCalled();
  });

  it('stops between pages when the run is aborted, keeping the pages already committed', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const shutdown = new AbortController();
    const firstPage = {
      ascents: [ascentRow('psync-ascent-page-1', CLIMB_UUID, '2026-05-01 22:00:00')],
      user_syncs: [
        { table_name: 'ascents', last_synchronized_at: '2026-05-02 00:00:00.000000', user_id: AURORA_USER_ID },
      ],
      _complete: false,
    };
    const secondPage = {
      ascents: [ascentRow('psync-ascent-page-2', CLIMB_UUID, '2026-05-03 22:00:00')],
      _complete: true,
    };
    // Page two is requested only after page one committed; the worker shuts
    // down at exactly that moment.
    const aurora = stubAuroraApi({
      pages: [firstPage, secondPage],
      onRequest: (kind, index) => {
        if (kind === 'sync' && index === 1) shutdown.abort();
      },
    });
    const runId = await enqueueSync(linkGeneration);

    expect(await executeNext(shutdown.signal)).toBe('failed');

    expect(await tickAuroraIds()).toEqual(['psync-ascent-page-1']);
    expect(aurora.requests).toEqual(['login', 'sync', 'sync']);
    // An abort is not a credential failure: nothing is recorded against the account.
    const credential = await credentialRow();
    expect(credential.consecutiveFailures).toBe(0);
    expect(credential.lastSyncError).toBeNull();
    expect((await runRow(runId)).status).toBe('retrying');
  });
});
