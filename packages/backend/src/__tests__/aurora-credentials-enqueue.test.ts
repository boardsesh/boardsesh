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
import { logger } from '../utils/logger';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../workers/jobs';
import {
  AURORA_USER_ID,
  FIXTURE_BOARD,
  ensureBackgroundJobSchema,
  fullSyncPage,
  insertLinkedTensionAccount,
  removeFixtures,
  stubAuroraApi,
} from '../workers/families/__tests__/provider-sync-fixtures';

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

// #6692: the Aurora cursor is one watermark per login. A new account linking a
// login another account synced must ask Aurora for the whole logbook, and the
// appliers must still leave every send the other account holds where it is.
describe('the first sync after a new account links a login another account synced', () => {
  const FIRST_USER = 'psync-producer-first';
  const CLIMB_UUID = 'psync-climb-producer';
  const WATERMARK = '2026-05-03 00:00:00.000000';
  const FROM_THE_BEGINNING = '1970-01-01 00:00:00.000000';
  const LOGBOOK_TABLES = ['ascents', 'bids', 'circuits'];

  // Spies a test installs, restored after it whatever it asserted.
  const spies: Array<{ mockRestore(): void }> = [];

  const cleanUp = async () => {
    await removeFixtures(database, [FIRST_USER], [CLIMB_UUID]);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM playlist_ownership WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM logbook_sync_skips WHERE user_id IN (${USER_ID}, ${FIRST_USER})`);
  };

  /** A watermark on every user table the first account's syncs pulled. */
  const seedCursor = async () => {
    for (const tableName of ['users', ...LOGBOOK_TABLES]) {
      await db.execute(sql`
        INSERT INTO board_user_syncs (board_type, user_id, table_name, last_synchronized_at)
        VALUES (${FIXTURE_BOARD}, ${AURORA_USER_ID}, ${tableName}, ${WATERMARK})
      `);
    }
  };

  const logbookCursorTables = async () =>
    Array.from(
      await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM board_user_syncs
         WHERE board_type = ${FIXTURE_BOARD} AND user_id = ${AURORA_USER_ID}
           AND table_name IN ('ascents', 'bids', 'circuits')
         ORDER BY table_name`),
      (row) => row.table_name,
    );

  /** The first account synced this login: its cursor, and one pulled send (no quality, one attempt). */
  const firstAccountSynced = async () => {
    await insertLinkedTensionAccount(database, FIRST_USER, CLIMB_UUID);
    await seedCursor();
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, origin, aurora_id, aurora_type)
      VALUES ('psync-first-tick', ${FIRST_USER}, ${FIXTURE_BOARD}, ${CLIMB_UUID}, 40, 'send', '2026-05-01 22:00:00',
              'aurora_pull', 'psync-ascent-1', 'ascents')
    `);
  };

  /** The form body of the first /sync request: the watermark of every table it asks for. */
  const firstSyncRequest = (fetchMock: ReturnType<typeof stubAuroraApi>['fetchMock']) => {
    const [syncBody] = fetchMock.mock.calls
      .filter(([input]) => typeof input === 'string' && input.endsWith('/sync'))
      .map(([, init]) => init?.body);
    if (typeof syncBody !== 'string') throw new Error('the sync sent no /sync request with a form body');
    return new URLSearchParams(syncBody);
  };

  const runNextJob = async (expectedRunId: string | null | undefined) => {
    const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    expect(job?.id).toBe(expectedRunId);
    return executeBackgroundJob(database, boss, job, handlerForRole(role), new AbortController().signal);
  };

  /** Link the second account and run the sync that link queued against a stand-in Aurora. */
  const linkAndRunFirstSync = async () => {
    signInMock.mockResolvedValue({ token: 'aurora-token', user_id: AURORA_USER_ID });
    const status = await link();
    const aurora = stubAuroraApi({ pages: [fullSyncPage(CLIMB_UUID)] });
    expect(await runNextJob(status.syncRunId)).toBe('succeeded');
    return firstSyncRequest(aurora.fetchMock);
  };

  const tickOwners = async () =>
    (
      await db.execute<{ aurora_id: string; user_id: string }>(
        sql`SELECT aurora_id, user_id FROM boardsesh_ticks WHERE aurora_id LIKE 'psync-%' ORDER BY aurora_id`,
      )
    ).map((row) => ({ auroraId: row.aurora_id, userId: row.user_id }));

  beforeEach(cleanUp);
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  afterAll(cleanUp);

  it('asks Aurora for the whole logbook when the first account was deleted', async () => {
    await firstAccountSynced();
    // Account deletion: prod cascades the ticks off users; the test schema has
    // no FK on boardsesh_ticks.user_id, so delete them the way the cascade would.
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${FIRST_USER}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${FIRST_USER}`);

    const request = await linkAndRunFirstSync();

    expect(request.get('ascents')).toBe(FROM_THE_BEGINNING);
    expect(request.get('bids')).toBe(FROM_THE_BEGINNING);
    expect(request.get('circuits')).toBe(FROM_THE_BEGINNING);
    // Rows keyed on the Aurora login itself keep their watermark.
    expect(request.get('users')).toBe(WATERMARK);
    expect(await tickOwners()).toEqual([
      { auroraId: 'psync-ascent-1', userId: USER_ID },
      { auroraId: 'psync-bid-1', userId: USER_ID },
    ]);
  });

  it('leaves every send the first account still holds with it when that account only unlinked', async () => {
    await firstAccountSynced();
    await deleteAuroraCredential(FIRST_USER, FIXTURE_BOARD);
    const warnSpy = vi.spyOn(console, 'warn');
    spies.push(warnSpy);

    const request = await linkAndRunFirstSync();

    expect(request.get('ascents')).toBe(FROM_THE_BEGINNING);
    // The re-read ascent stays the first account's; the bid nobody held lands
    // on the new account.
    expect(await tickOwners()).toEqual([
      { auroraId: 'psync-ascent-1', userId: FIRST_USER },
      { auroraId: 'psync-bid-1', userId: USER_ID },
    ]);
    // No applier path rewrites a tick's user_id, so ownership alone can't fail:
    // the first account's row must also keep its content (the re-read ascent
    // carries quality 3 and 3 attempts).
    const firstRows = await db.execute<{ quality_null: boolean; attempt_count: number; never_synced: boolean }>(sql`
      SELECT quality IS NULL AS quality_null, attempt_count, aurora_synced_at IS NULL AS never_synced
        FROM boardsesh_ticks WHERE uuid = 'psync-first-tick'`);
    expect(Array.from(firstRows, (row) => ({ ...row }))).toEqual([
      { quality_null: true, attempt_count: 1, never_synced: true },
    ]);
    // The foreign-owner partition refused it, not only the write-time predicate.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('psync-ascent-1 already linked to a different'));
    // And it was refused, not inserted and quarantined for the new account.
    const skips = await db.execute<{ aurora_id: string }>(
      sql`SELECT aurora_id FROM logbook_sync_skips WHERE user_id = ${USER_ID}`,
    );
    expect(Array.from(skips, (row) => row.aurora_id)).toEqual([]);
  });

  it('a run of the previous link that is between pages cannot write its watermark over the reset', async () => {
    const LATER = '2026-06-01 00:00:00.000000';
    // A page that only moves the cursor: no ticks, so a relink after it still
    // finds no footprint and resets again.
    const cursorPage = (complete: boolean) => ({
      users: [{ id: AURORA_USER_ID, username: 'climber', created_at: '2024-01-01 00:00:00' }],
      user_syncs: LOGBOOK_TABLES.map((tableName) => ({
        table_name: tableName,
        last_synchronized_at: LATER,
        user_id: AURORA_USER_ID,
      })),
      _complete: complete,
    });
    signInMock.mockResolvedValue({ token: 'aurora-token', user_id: AURORA_USER_ID });
    const first = await link('pw1');
    let second: Awaited<ReturnType<typeof link>> | undefined;
    stubAuroraApi({
      pages: [cursorPage(false), cursorPage(true)],
      onRequest: async (kind, index) => {
        // The first page has committed its cursor; relink before the second.
        if (kind === 'sync' && index === 1) second = await link('pw2');
      },
    });

    // The old run's second page meets the new link generation and is refused,
    // so the reset holds. The cursor first: it is what a regression breaks.
    const oldRun = await runNextJob(first.syncRunId);
    expect(await logbookCursorTables()).toEqual([]);
    expect(oldRun).toBe('failed');

    const aurora = stubAuroraApi({ pages: [cursorPage(true)] });
    expect(await runNextJob(second?.syncRunId)).toBe('succeeded');
    expect(firstSyncRequest(aurora.fetchMock).get('ascents')).toBe(FROM_THE_BEGINNING);
  });

  it('logs a reset only once the link has committed', async () => {
    await seedCursor();
    signInMock.mockResolvedValue({ token: 'aurora-token', user_id: AURORA_USER_ID });
    const infoSpy = vi.spyOn(logger, 'info');
    spies.push(infoSpy);
    const resetLines = () =>
      // winston's overloads type the arguments loosely; match on their JSON.
      infoSpy.mock.calls.filter((call) => JSON.stringify(call).includes('(#6692)'));

    setPendingFailure.next = new Error('simulated failure after enqueue');
    await expect(link()).rejects.toThrow('simulated failure after enqueue');
    // Rolled back with the link: the rows are back and nothing was counted.
    expect(await logbookCursorTables()).toEqual(LOGBOOK_TABLES);
    expect(resetLines()).toEqual([]);

    await link();
    expect(await logbookCursorTables()).toEqual([]);
    expect(resetLines()).toHaveLength(1);
  });
});
