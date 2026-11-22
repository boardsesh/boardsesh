process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, boardseshTicks, providerSyncControls } from '@boardsesh/db/schema';
import {
  acquireCredentialSyncLease,
  drainPendingClimbStatsRecomputes,
  rotateLinkGeneration,
} from '@boardsesh/db/queries';
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

async function executeNext(signal = new AbortController().signal, afterTransaction?: () => Promise<void>) {
  const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  expect(job).toBeDefined();
  const handler = handlerForRole(role);
  return executeBackgroundJob(
    database,
    boss,
    job,
    {
      ...handler,
      resolveFamily(name) {
        const family = handler.resolveFamily(name);
        if (!family || !afterTransaction) return family;
        return {
          ...family,
          async execute(context, payload) {
            return family.execute(
              {
                ...context,
                async transaction(callback) {
                  const result = await context.transaction(callback);
                  // Observe only committed state. No second pool read occurs
                  // inside the write transaction or holds up its commit.
                  await afterTransaction();
                  return result;
                },
              },
              payload,
            );
          },
        };
      },
    },
    signal,
  );
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
  it('keeps the heartbeat alive while importing one large Aurora page', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const checkpoint = '2026-05-03 00:00:00.000000';
    const ascents = Array.from({ length: 1000 }, (_, index) =>
      ascentRow(
        `psync-large-${index.toString().padStart(4, '0')}`,
        CLIMB_UUID,
        new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString(),
      ),
    );
    stubAuroraApi({
      pages: [
        {
          users: [{ id: AURORA_USER_ID, username: 'climber', created_at: '2024-01-01 00:00:00' }],
          ascents,
          user_syncs: [{ table_name: 'ascents', last_synchronized_at: checkpoint, user_id: AURORA_USER_ID }],
          _complete: true,
        },
      ],
    });
    const runId = await enqueueSync(linkGeneration);
    // Ten seconds is pg-boss's smallest supported heartbeat window. The test
    // slows only its fixture inserts: one whole page takes at least 15 s,
    // whereas bounded batches let the real heartbeat timer renew between them.
    await owner`UPDATE pgboss.job SET heartbeat_seconds = 10 WHERE name = ${queue} AND id = ${runId}`;
    await owner.unsafe(`
      CREATE FUNCTION psync_slow_import_tick() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = 'psync-aurora-user' AND NEW.aurora_id LIKE 'psync-large-%' THEN
          PERFORM pg_sleep(0.015);
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER psync_slow_import_tick BEFORE INSERT ON boardsesh_ticks
      FOR EACH ROW EXECUTE FUNCTION psync_slow_import_tick();
    `);
    try {
      expect(await executeNext()).toBe('succeeded');
      expect(await tickAuroraIds()).toEqual(ascents.map((ascent) => ascent.uuid));
      const [cursor] = await owner`SELECT last_synchronized_at FROM board_user_syncs
        WHERE board_type = ${FIXTURE_BOARD} AND user_id = ${AURORA_USER_ID} AND table_name = 'ascents'`;
      expect(cursor.last_synchronized_at).toBe(checkpoint);
      expect(await credentialRow()).toMatchObject({ syncStatus: 'active', syncError: null });
      const completed = await runRow(runId);
      expect(completed.status).toBe('succeeded');
      expect(completed.heartbeatAt!.getTime()).toBeGreaterThan(completed.startedAt!.getTime() + 3000);
    } finally {
      await owner.unsafe(
        'DROP TRIGGER psync_slow_import_tick ON boardsesh_ticks; DROP FUNCTION psync_slow_import_tick()',
      );
    }
  }, 45_000);

  it('replays an interrupted page without duplicate sends or losing pending stats', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const shutdown = new AbortController();
    const checkpoint = '2026-05-03 00:00:00.000000';
    const ascents = Array.from({ length: 201 }, (_, index) =>
      ascentRow(
        `psync-replay-${index.toString().padStart(4, '0')}`,
        CLIMB_UUID,
        new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString(),
      ),
    );
    stubAuroraApi({
      pages: [
        {
          users: [{ id: AURORA_USER_ID, username: 'climber', created_at: '2024-01-01 00:00:00' }],
          ascents,
          user_syncs: [{ table_name: 'ascents', last_synchronized_at: checkpoint, user_id: AURORA_USER_ID }],
          _complete: true,
        },
      ],
    });
    const runId = await enqueueSync(linkGeneration);
    let interrupted = false;
    expect(
      await executeNext(shutdown.signal, async () => {
        const ticks = await tickAuroraIds();
        if (!interrupted && ticks.length > 0 && ticks.length < ascents.length) {
          interrupted = true;
          shutdown.abort();
        }
      }),
    ).toBe('failed');
    expect(interrupted).toBe(true);
    expect(await tickAuroraIds()).toHaveLength(100);
    expect(
      await owner`SELECT 1 FROM board_user_syncs
      WHERE board_type = ${FIXTURE_BOARD} AND user_id = ${AURORA_USER_ID}`,
    ).toHaveLength(0);
    expect(
      await owner`SELECT 1 FROM climb_stats_recompute_pending
      WHERE board_type = ${FIXTURE_BOARD} AND climb_uuid = ${CLIMB_UUID}`,
    ).toHaveLength(1);
    // A new process can recover committed stats without the interrupted
    // collector's in-memory keys, even before the import retry finishes.
    expect(
      await drainPendingClimbStatsRecomputes((callback) => database.transaction(callback), { olderThanMs: 0 }),
    ).toBe(1);
    await owner`UPDATE pgboss.job SET start_after = now() WHERE name = ${queue} AND id = ${runId}`;
    expect(await executeNext()).toBe('succeeded');
    expect(await tickAuroraIds()).toEqual(ascents.map((ascent) => ascent.uuid));
    const [cursor] = await owner`SELECT last_synchronized_at FROM board_user_syncs
      WHERE board_type = ${FIXTURE_BOARD} AND user_id = ${AURORA_USER_ID} AND table_name = 'ascents'`;
    expect(cursor.last_synchronized_at).toBe(checkpoint);
    expect((await runRow(runId)).attemptNumber).toBe(1);
  });

  it('refuses old-link chunks and their checkpoint after a relink mid-page', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const ascents = Array.from({ length: 201 }, (_, index) =>
      ascentRow(
        `psync-relink-${index.toString().padStart(4, '0')}`,
        CLIMB_UUID,
        new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString(),
      ),
    );
    stubAuroraApi({
      pages: [
        {
          users: [{ id: AURORA_USER_ID, username: 'climber', created_at: '2024-01-01 00:00:00' }],
          ascents,
          user_syncs: [
            { table_name: 'ascents', last_synchronized_at: '2026-05-03 00:00:00.000000', user_id: AURORA_USER_ID },
          ],
          _complete: true,
        },
      ],
    });
    const runId = await enqueueSync(linkGeneration);
    let relinked = false;
    expect(
      await executeNext(undefined, async () => {
        const ticks = await tickAuroraIds();
        if (!relinked && ticks.length > 0 && ticks.length < ascents.length) {
          relinked = true;
          await database.transaction((transaction) =>
            rotateLinkGeneration(transaction, {
              userId: USER_ID,
              boardType: FIXTURE_BOARD,
              linked: true,
            }),
          );
        }
      }),
    ).toBe('failed');
    expect(relinked).toBe(true);
    expect(await tickAuroraIds()).toHaveLength(100);
    expect(
      await owner`SELECT 1 FROM board_user_syncs
      WHERE board_type = ${FIXTURE_BOARD} AND user_id = ${AURORA_USER_ID}`,
    ).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: 'failed', errorCode: 'STALE_LINK_GENERATION' });
    expect((await credentialRow()).lastSyncAt).toBeNull();
  });

  it('keeps the last valid duplicate log when its malformed copy crosses a write boundary', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const ascents = Array.from({ length: 101 }, (_, index) =>
      ascentRow(
        `psync-duplicate-${index.toString().padStart(4, '0')}`,
        CLIMB_UUID,
        new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString(),
      ),
    );
    stubAuroraApi({
      pages: [
        {
          ascents: [
            ...ascents,
            { ...ascents[0], comment: 'last valid upstream copy' },
            { ...ascents[0], climbed_at: 'not-a-timestamp', comment: 'malformed final copy' },
          ],
          _complete: true,
        },
      ],
    });
    await enqueueSync(linkGeneration);
    expect(await executeNext()).toBe('succeeded');
    expect(await tickAuroraIds()).toEqual(ascents.map((ascent) => ascent.uuid));
    const [kept] = await database
      .select({ comment: boardseshTicks.comment })
      .from(boardseshTicks)
      .where(eq(boardseshTicks.auroraId, ascents[0]!.uuid));
    expect(kept.comment).toBe('last valid upstream copy');
  });

  it('releases a tombstoned native tick before a live claim from an earlier wire batch', async () => {
    const { linkGeneration } = await insertLinkedTensionAccount(database, USER_ID, CLIMB_UUID);
    const nativeUuid = 'psync-native-to-reclaim';
    await database.insert(boardseshTicks).values({
      uuid: nativeUuid,
      userId: USER_ID,
      boardType: FIXTURE_BOARD,
      climbUuid: CLIMB_UUID,
      angle: 40,
      status: 'send',
      origin: 'native',
      climbedAt: '2026-05-01T22:00:00.000Z',
      auroraType: 'ascents',
      auroraId: 'psync-previous-claim',
      auroraSyncedAt: '2026-05-02T00:00:00.000Z',
    });
    const replacement = ascentRow('psync-new-claim', CLIMB_UUID, '2026-05-01 22:00:00');
    const otherAscents = Array.from({ length: 100 }, (_, index) =>
      ascentRow(
        `psync-other-${index.toString().padStart(4, '0')}`,
        CLIMB_UUID,
        new Date(Date.UTC(2026, 4, 5, 0, 0, index)).toISOString(),
      ),
    );
    stubAuroraApi({
      pages: [
        {
          ascents: [replacement, ...otherAscents, { uuid: 'psync-previous-claim', is_listed: false }],
          _complete: true,
        },
      ],
    });
    await enqueueSync(linkGeneration);
    expect(await executeNext()).toBe('succeeded');
    expect(await tickAuroraIds()).toHaveLength(101);
    const [claimed] = await database
      .select({ uuid: boardseshTicks.uuid, origin: boardseshTicks.origin })
      .from(boardseshTicks)
      .where(eq(boardseshTicks.auroraId, replacement.uuid));
    expect(claimed).toEqual({ uuid: nativeUuid, origin: 'native' });
  });

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
